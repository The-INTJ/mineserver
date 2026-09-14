import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Profile, Runtime, ServerState, ReliabilityStatus } from "../../shared/types.ts";
import { READY_TIMEOUT_MS, STOP_TIMEOUT_MS } from "../../shared/constants.ts";
import type { Paths } from "../config.ts";
import { conflict } from "../errors.ts";
import { eulaAccepted } from "../fabric/eula.ts";
import type { ModLibrary } from "../mods/mod-library.ts";
import { applyModPlan, planMods } from "../profiles/materialize.ts";
import type { ProfileStore } from "../profiles/profile-store.ts";
import { buildServerProperties } from "../profiles/server-properties.ts";
import type { RuntimeStore } from "../runtime/runtime-store.ts";
import { loaderCompatible, runtimeId, worldMode } from "../runtime/runtimes.ts";
import type { StateStore } from "../state-store.ts";
import type { WorldStore } from "../worlds/world-store.ts";
import { IncidentStore } from "./incidents.ts";
import { readJson } from "../fsx.ts";
import { JavaProcess } from "./java-process.ts";
import { LogBuffer } from "./log-buffer.ts";
import { LogFile, pruneLogFiles } from "./log-file.ts";

export interface ServerManagerDeps {
  paths: Paths;
  logs: LogBuffer;
  state: StateStore;
  profiles: ProfileStore;
  library: ModLibrary;
  worlds: WorldStore;
  runtimes: RuntimeStore;
  /** Test seam: override the spawned command entirely (e.g. `node fake-java.mjs`). */
  stopTimeoutMs?: number;
  recoveryDelayMs?: number;
  spawnOverride?: { javaPath: string; args: string[] };
}

const KEEP_LOG_FILES = 30;
/** Longest silence tolerated during boot. Real boots print at least every few seconds. */
const STARTUP_QUIET_WARNING_MS = 120_000;

/**
 * The state machine that owns the Java child. Everything else (routes, MCP, UI) reads
 * `getState()` and subscribes to "state" events; nothing else touches the process.
 *
 *   stopped/crashed --start--> starting --"Done"--> running --stop--> stopping --exit--> stopped
 *                                  \-- exit non-zero --> crashed
 */
export class ServerManager extends EventEmitter {
  private proc: JavaProcess | null = null;
  private logFile: LogFile | null = null;
  readonly incidents: IncidentStore;
  private starting: Promise<ServerState> | null = null;
  private stopping: Promise<ServerState> | null = null;
  private restarting = false;
  private closing = false;
  private completion = Promise.resolve();
  private recoveryTimer: NodeJS.Timeout | null = null;
  private recoveryAttempts: number[] = [];
  private recoveryEnabled = false;
  private nextAttemptAt: string | null = null;
  private blockedReason: string | null = null;
  private loggingError: string | null = null;
  private crashCandidate: string | null = null;
  private intentionalStop = false;
  private forced = false;
  private captureLine = (line: import("../../shared/types.ts").LogLine) =>
    this.logFile?.write(line);
  private readyTimer: NodeJS.Timeout | null = null;
  private state: ServerState = {
    status: "stopped",
    activeProfileId: null,
    pid: null,
    startedAt: null,
    readyAt: null,
    players: [],
    lastExitCode: null,
    lastStopReason: null,
  };
  /** Runtime of the profile that was last launched (for logs/snapshot while running). */
  activeRuntime: Runtime | null = null;
  /** For the debug snapshot. */
  lastJvmArgs: string[] = [];
  lastEffectiveProperties: Record<string, string> | null = null;

  constructor(private readonly deps: ServerManagerDeps) {
    super();
    this.incidents = new IncidentStore(path.join(deps.paths.data, "incidents"));
    deps.logs.on("line", this.captureLine);
  }

  reliability(): ReliabilityStatus {
    return {
      run: this.incidents.current ? structuredClone(this.incidents.current) : null,
      loggingError: this.loggingError ?? this.incidents.error,
      recovery: {
        enabled: this.recoveryEnabled,
        attempts: this.recoveryAttempts.length,
        nextAttemptAt: this.nextAttemptAt,
        blockedReason: this.blockedReason,
      },
    };
  }
  private cancelRecovery(): void {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.nextAttemptAt = null;
  }
  async dispose(): Promise<void> {
    this.closing = true;
    this.cancelRecovery();
    await this.stop();
    await this.completion;
    await this.incidents.flush();
    this.deps.logs.off("line", this.captureLine);
  }

  getState(): ServerState {
    return { ...this.state, players: [...this.state.players] };
  }

  get isActive(): boolean {
    return (
      this.starting !== null ||
      this.restarting ||
      this.state.status === "starting" ||
      this.state.status === "running" ||
      this.state.status === "stopping"
    );
  }

  async init(): Promise<void> {
    await this.incidents.init();
    const config = await readJson<{ autoRestart?: boolean }>(
      path.join(this.deps.paths.data, "reliability.json"),
      {},
    );
    this.recoveryEnabled = config.autoRestart === true;
    const previous = this.incidents.current;
    if (previous) {
      this.state.lastStopReason = previous.reason;
      this.state.lastExitCode = previous.code;
    }
    const persisted = await this.deps.state.get();
    this.state.activeProfileId = persisted.activeProfileId;
    if (persisted.activeProfileId) {
      const p = await this.deps.profiles.get(persisted.activeProfileId).catch(() => null);
      this.activeRuntime = p?.runtime ?? null;
    }
  }

  async start(profileId?: string): Promise<ServerState> {
    if (this.isActive || this.stopping || this.closing)
      throw conflict("SERVER_RUNNING", `Server is busy (${this.state.status})`);
    this.cancelRecovery();
    this.starting = this.startInternal(profileId);
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startInternal(profileId?: string): Promise<ServerState> {
    await this.completion;
    this.intentionalStop = false;
    this.forced = false;
    this.crashCandidate = null;
    this.loggingError = null;
    this.blockedReason = null;
    const { logs, state, profiles, library, worlds, runtimes } = this.deps;

    const persisted = await state.get();
    const id = profileId ?? persisted.activeProfileId ?? (await profiles.ensureDefault()).id;
    const profile = await profiles.get(id);
    const rt = profile.runtime;
    const rp = runtimes.paths(rt);
    this.activeRuntime = rt;

    // 0. Preflight: runtime installed, EULA, Java.
    if (!this.deps.spawnOverride) {
      if (!(await runtimes.installed(rt))) {
        throw conflict("RUNTIME_MISSING", `Runtime ${runtimeId(rt)} is not installed yet`);
      }
      await runtimes.ensureEula(rt, persisted.eulaAccepted);
      if (!(await eulaAccepted(rp.dir))) {
        throw conflict("EULA_REQUIRED", "Accept the Minecraft EULA before starting");
      }
    }
    const spawnSpec = this.deps.spawnOverride ?? (await runtimes.launchSpec(rt, profile.jvm));

    const run = await this.incidents.begin(profile.id, runtimeId(rt));
    const proc = new JavaProcess();
    this.proc = proc;
    proc.on("warning", (message: string) => logs.note(message));
    proc.on("exit", (code: number | null, signal: string | null) => {
      if (this.proc === proc) this.completion = this.finish(proc, code, signal);
    });
    try {
      await proc.prepare(rp.dir, this.incidents.receiptFile(run.id));
      // 1. World. Fabric 26.x: junction at <runtime>/world. Forge/NeoForge (1.20.x/1.21.x): no
      //    link, level-name points into data/worlds by relative path (see runtimes.worldMode for
      //    the Java-vs-junction reason). Either way the world dir is created if missing.
      let levelName = "world";
      if (worldMode(rt) === "junction") {
        await worlds.link(profile.world, rp.worldLink);
      } else {
        const worldDir = await worlds.ensure(profile.world);
        levelName = path.relative(rp.dir, worldDir).split(path.sep).join("/");
        // A leftover junction from an earlier attempt would confuse the validator; drop it.
        const st = await fs.lstat(rp.worldLink).catch(() => null);
        if (st?.isSymbolicLink()) await fs.rm(rp.worldLink, { force: true });
      }
      logs.note(
        `profile "${profile.name}" (${profile.id}); runtime ${runtimeId(rt)}; world "${profile.world}" (level-name=${levelName})`,
      );

      // 2. Mods: rebuild <runtime>/mods from the library, skipping jars built for another loader.
      const lib = await library.list();
      const libraryFiles = new Set(lib.map((m) => m.file));
      const byFile = new Map(lib.map((m) => [m.file, m]));
      const enabled = profile.enabledMods.filter((f) => {
        const m = byFile.get(f);
        if (m && !loaderCompatible(m.loaders, rt)) {
          logs.note(`skipping ${f}: built for ${m.loaders.join("+")}, runtime is ${rt.loader}`);
          return false;
        }
        return true;
      });
      await fs.mkdir(rp.mods, { recursive: true });
      const existing = await fs.readdir(rp.mods).catch(() => [] as string[]);
      const plan = planMods(enabled, libraryFiles, this.deps.paths.modLibrary, rp.mods, existing);
      if (plan.missing.length)
        throw conflict(
          "MODS_MISSING",
          `Refusing to open world with missing enabled mods: ${plan.missing.join(", ")}`,
        );
      const applied = await applyModPlan(plan);
      logs.note(
        `mods: ${plan.link.length} enabled (${applied.linked} linked, ${applied.copied} copied)`,
      );

      // 3. server.properties from template + profile overrides + forced keys.
      const template = await fs.readFile(
        path.join(this.deps.paths.templates, "server.properties.default"),
        "utf8",
      );
      const built = buildServerProperties(template, profile.properties, levelName);
      await fs.writeFile(rp.properties, built.text, "utf8");
      this.lastEffectiveProperties = built.effective;

      // 4. Log file for this launch.
      await pruneLogFiles(this.deps.paths.logs, "server", KEEP_LOG_FILES - 1).catch(
        (err: unknown) => {
          this.loggingError = `Log retention unavailable: ${String(err)}`;
        },
      );
      this.logFile = new LogFile(this.deps.paths.logs, "server", (message) => {
        this.loggingError = message;
        console.error(message);
      });
      try {
        await this.logFile.open();
      } catch (err) {
        this.loggingError = `Log capture unavailable: ${String(err)}`;
        console.error(this.loggingError);
      }
      await this.incidents.patch({ logFile: path.basename(this.logFile.file) });

      // 5. Spawn.
      this.lastJvmArgs = spawnSpec.args;
      this.setState({
        status: "starting",
        activeProfileId: profile.id,
        startedAt: new Date().toISOString(),
        readyAt: null,
        players: [],
        lastExitCode: null,
        lastStopReason: null,
      });
      await state.patch({ activeProfileId: profile.id, lastStartedAt: this.state.startedAt });

      proc.on("line", (stream: "stdout" | "stderr", text: string) => this.onLine(stream, text));

      logs.note(`launching in ${rp.dir}: ${spawnSpec.javaPath} ${spawnSpec.args.join(" ")}`);
      await proc.start(
        { javaPath: spawnSpec.javaPath, args: spawnSpec.args, cwd: rp.dir },
        this.deps.stopTimeoutMs ?? STOP_TIMEOUT_MS,
      );
      this.setState({ pid: proc.pid });
      await this.incidents.patch({ pid: proc.pid });

      this.readyTimer = setTimeout(() => {
        if (this.state.status === "starting") {
          logs.note(`startup exceeded ${READY_TIMEOUT_MS / 60000} min; requesting graceful stop`);
          this.crashCandidate = "startup timeout";
          proc.requestStop("startup timeout");
        }
      }, READY_TIMEOUT_MS);
      // Quiet startup is diagnostic evidence, not proof that the JVM has failed.
      this.armQuietWatchdog(proc);
      return this.getState();
    } catch (err) {
      proc.killSync();
      this.setState({ status: "stopping" });
      await proc.waitForExit();
      await this.completion;
      await this.incidents.patch({
        endedAt: new Date().toISOString(),
        outcome: "crashed",
        reason: `Start failed: ${String(err)}`,
      });
      this.setState({
        status: "crashed",
        pid: null,
        lastStopReason: `Start failed: ${String(err)}`,
      });
      if (this.proc === proc) this.proc = null;
      throw err;
    }
  }

  async stop(): Promise<ServerState> {
    this.intentionalStop = true;
    this.cancelRecovery();
    if (this.stopping) return this.stopping;
    this.stopping = this.stopInternal();
    try {
      return await this.stopping;
    } finally {
      this.stopping = null;
    }
  }
  private async stopInternal(): Promise<ServerState> {
    await this.starting?.catch(() => undefined);
    this.intentionalStop = true;
    const proc = this.proc;
    if (!proc || !proc.alive) {
      await this.completion;
      return this.getState();
    }
    this.setState({ status: "stopping" });
    this.deps.logs.note("sending graceful stop; waiting for save confirmation and process exit");
    await this.incidents.patch({ reason: "stopped by request" });
    const timeout = this.deps.stopTimeoutMs ?? STOP_TIMEOUT_MS;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.forced = true;
        this.deps.logs.note(`no exit after ${timeout / 1000}s; force stop requested`);
        void this.incidents.patch({ forced: true, reason: "graceful stop timed out" });
        void proc.kill();
      }, timeout);
      const hardLimit = setTimeout(() => {
        clearTimeout(timer);
        proc.off("exit", done);
        reject(
          new Error("Server did not exit after force stop; ownership retained, restart refused"),
        );
      }, timeout + 15000);
      const done = () => {
        clearTimeout(timer);
        clearTimeout(hardLimit);
        resolve();
      };
      proc.once("exit", done);
      proc.requestStop();
    });
    await this.completion;
    return this.getState();
  }
  async restart(): Promise<ServerState> {
    if (this.restarting || this.starting || this.stopping)
      throw conflict("SERVER_RUNNING", "Lifecycle operation in progress");
    this.restarting = true;
    const id = this.state.activeProfileId ?? undefined;
    try {
      await this.stop();
    } finally {
      this.restarting = false;
    }
    return this.start(id);
  }

  async save(): Promise<{ savedAt: string }> {
    if (this.state.status !== "running" || !this.proc?.alive)
      throw conflict("SERVER_NOT_RUNNING", "Server is not running");
    return new Promise((resolve, reject) => {
      const proc = this.proc!;
      const cleanup = () => {
        clearTimeout(timer);
        this.deps.logs.off("line", onLine);
        proc.off("exit", onExit);
      };
      const onExit = () => {
        cleanup();
        reject(new Error("Server exited before save acknowledgement"));
      };
      const onLine = (line: import("../../shared/types.ts").LogLine) => {
        if (
          line.stream !== "daemon" &&
          /\[Server thread\/INFO\](?: \[[^\]]+\])?: Saved the game\s*$/.test(line.text)
        ) {
          cleanup();
          resolve({ savedAt: line.ts });
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Save acknowledgement timed out; inspect logs"));
      }, 30000);
      this.deps.logs.on("line", onLine);
      proc.once("exit", onExit);
      if (!proc.write("save-all flush")) onExit();
    });
  }

  send(command: string): void {
    const proc = this.proc;
    if (
      !proc ||
      !proc.alive ||
      (this.state.status !== "running" && this.state.status !== "starting")
    ) {
      throw conflict("SERVER_NOT_RUNNING", "Server is not running");
    }
    if (/[\r\n\0]/.test(command)) throw conflict("BAD_COMMAND", "Send a single command");
    if (command.trim() === "stop") {
      void this.stop().catch((err: unknown) => this.deps.logs.note(String(err)));
      return;
    }
    // Commands can contain tokens, passwords or private chat. Persist only the verb.
    this.deps.logs.push("daemon", `> ${command.split(/\s/)[0]} [arguments omitted]`);
    if (!proc.write(command))
      throw conflict("SERVER_NOT_RUNNING", "Java command channel unavailable");
  }

  /** For process.on("exit"): disconnect so the independent guardian saves and stops Java. */
  killSync(): void {
    this.proc?.killSync();
  }

  /** Called by the profiles route after `activate` so snapshot/logs follow the new runtime. */
  setActiveProfile(profile: Profile | null): void {
    this.state = { ...this.state, activeProfileId: profile?.id ?? null };
    this.activeRuntime = profile?.runtime ?? null;
    this.emit("state", this.getState());
  }

  // ---- internals -------------------------------------------------------------------------

  private quietTimer: NodeJS.Timeout | null = null;
  private lastLineAt = 0;

  private armQuietWatchdog(proc: JavaProcess): void {
    if (this.quietTimer) clearInterval(this.quietTimer);
    this.lastLineAt = Date.now();
    this.quietTimer = setInterval(() => {
      if (this.proc !== proc || !proc.alive || this.state.status !== "starting") {
        if (this.quietTimer) clearInterval(this.quietTimer);
        this.quietTimer = null;
        return;
      }
      if (Date.now() - this.lastLineAt > STARTUP_QUIET_WARNING_MS) {
        this.deps.logs.note(
          `no output for ${STARTUP_QUIET_WARNING_MS / 1000}s while starting; check startup progress`,
        );
        this.lastLineAt = Date.now();
      }
    }, 5_000);
  }

  private onLine(stream: "stdout" | "stderr", text: string): void {
    this.lastLineAt = Date.now();
    const line = this.deps.logs.push(stream, text);
    if (
      /\[Server thread\/INFO\](?: \[[^\]]+\])?: (?:ThreadedAnvilChunkStorage: All dimensions are saved|Saved the game)\s*$/.test(
        text,
      )
    ) {
      void this.incidents.patch({ saveConfirmedAt: new Date().toISOString() });
    }
    const lag = /(?:Running|jumping) (\d+)ms/.exec(text);
    if (lag && this.incidents.current) {
      const run = this.incidents.current;
      run.lagWarnings++;
      run.worstLagMs = Math.max(run.worstLagMs, Number(lag[1]));
    }
    switch (line.kind) {
      case "done":
        if (this.state.status === "starting") {
          const readyAt = new Date().toISOString();
          this.setState({ status: "running", readyAt, lastStopReason: null });
          this.crashCandidate = null;
          if (this.readyTimer) clearTimeout(this.readyTimer);
          void this.incidents.patch({ outcome: "running", readyAt });
        }
        break;
      case "join":
        if (line.player && !this.state.players.includes(line.player)) {
          this.setState({ players: [...this.state.players, line.player] });
        }
        break;
      case "leave":
        if (line.player)
          this.setState({ players: this.state.players.filter((p) => p !== line.player) });
        break;
      case "eula":
        this.crashCandidate = "EULA not accepted (eula.txt)";
        break;
      case "crash":
        this.crashCandidate ??= line.text.slice(0, 200);
        // Forge failures can leave non-daemon threads alive. Ask for a save/stop first;
        // the guardian enforces the normal grace period if the JVM cannot respond.
        if (
          this.state.status === "starting" &&
          /Failed to start the minecraft server/i.test(line.text)
        ) {
          const proc = this.proc;
          setTimeout(() => {
            if (proc && proc.alive && this.proc === proc && this.state.status === "starting") {
              this.deps.logs.note(
                "server failed to start and did not exit; requesting graceful stop",
              );
              proc.requestStop("startup failure");
            }
          }, 15_000);
        }
        break;
    }
  }

  private async finish(
    proc: JavaProcess,
    code: number | null,
    signal: string | null,
  ): Promise<void> {
    if (this.proc !== proc) return;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    if (this.quietTimer) clearInterval(this.quietTimer);
    this.readyTimer = null;
    this.quietTimer = null;
    const run = this.incidents.current!;
    const receipt = await readJson<{
      forced?: boolean;
      reason?: string;
      saveConfirmedAt?: string;
      endedAt?: string;
      code?: number | null;
      signal?: string | null;
    }>(this.incidents.receiptFile(run.id), {}).catch((err: unknown) => {
      this.loggingError = `Guardian receipt unavailable: ${String(err)}`;
      return {} as {
        forced?: boolean;
        reason?: string;
        saveConfirmedAt?: string;
        endedAt?: string;
        code?: number | null;
        signal?: string | null;
      };
    });
    if (receipt.endedAt) {
      code = receipt.code ?? null;
      signal = receipt.signal ?? null;
    }
    const forced = this.forced || receipt.forced === true;
    const crashed = !this.intentionalStop && (code !== 0 || this.crashCandidate !== null);
    const reason = forced
      ? "forced stop after timeout; final save is not guaranteed"
      : this.intentionalStop
        ? "stopped by request"
        : (this.crashCandidate ??
          receipt.reason ??
          (crashed
            ? `exited with code ${code}${signal ? ` (${signal})` : ""}`
            : "exited normally"));
    this.deps.logs.note(`server process exited (code ${code}, signal ${signal}); ${reason}`);
    await this.incidents.patch({
      endedAt: new Date().toISOString(),
      code,
      signal,
      reason,
      forced,
      saveConfirmedAt: receipt.saveConfirmedAt ?? run.saveConfirmedAt,
      outcome: forced ? "forced" : crashed ? "crashed" : "stopped",
    });
    await this.logFile?.close();
    this.logFile = null;
    this.proc = null;
    this.setState({
      status: crashed || forced ? "crashed" : "stopped",
      pid: null,
      players: [],
      lastExitCode: code,
      lastStopReason: reason,
    });
    if (crashed && run.readyAt && !this.intentionalStop && !this.closing && this.recoveryEnabled) {
      const now = Date.now();
      this.recoveryAttempts = this.recoveryAttempts.filter((t) => now - t < 15 * 60000);
      if (this.recoveryAttempts.length >= 3) {
        this.blockedReason =
          "Three recovery attempts in 15 minutes; inspect the incident before starting again";
        return;
      }
      const delay = (this.deps.recoveryDelayMs ?? 30000) * 2 ** this.recoveryAttempts.length;
      this.nextAttemptAt = new Date(now + delay).toISOString();
      this.deps.logs.note(`automatic recovery scheduled in ${delay / 1000}s`);
      this.recoveryTimer = setTimeout(() => {
        this.recoveryAttempts.push(Date.now());
        void this.start(run.profileId).catch((err: unknown) => {
          this.blockedReason = `Recovery failed: ${String(err)}`;
          this.deps.logs.note(this.blockedReason);
        });
      }, delay);
      this.recoveryTimer.unref();
    }
  }

  private setState(patch: Partial<ServerState>): void {
    this.state = { ...this.state, ...patch };
    this.emit("state", this.getState());
  }
}
