import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Profile, ServerState } from "../../shared/types.ts";
import { READY_TIMEOUT_MS, STOP_TIMEOUT_MS } from "../../shared/constants.ts";
import type { Paths } from "../config.ts";
import { conflict } from "../errors.ts";
import { eulaAccepted } from "../fabric/eula.ts";
import { launcherJarPath, launcherPresent } from "../fabric/fabric-launcher.ts";
import { probeJava } from "../fabric/java-info.ts";
import type { ModLibrary } from "../mods/mod-library.ts";
import { applyModPlan, planMods } from "../profiles/materialize.ts";
import type { ProfileStore } from "../profiles/profile-store.ts";
import { buildServerProperties } from "../profiles/server-properties.ts";
import type { StateStore } from "../state-store.ts";
import type { WorldStore } from "../worlds/world-store.ts";
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
  javaPath: string;
  /** Test seam: override the spawned command entirely (e.g. `node fake-java.mjs`). */
  spawnOverride?: { javaPath: string; args: string[] };
}

const KEEP_LOG_FILES = 30;

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
  /** For the debug snapshot. */
  lastJvmArgs: string[] = [];
  lastEffectiveProperties: Record<string, string> | null = null;

  constructor(private readonly deps: ServerManagerDeps) {
    super();
  }

  getState(): ServerState {
    return { ...this.state, players: [...this.state.players] };
  }

  get isActive(): boolean {
    return (
      this.state.status === "starting" ||
      this.state.status === "running" ||
      this.state.status === "stopping"
    );
  }

  async init(): Promise<void> {
    const persisted = await this.deps.state.get();
    this.state.activeProfileId = persisted.activeProfileId;
  }

  async start(profileId?: string): Promise<ServerState> {
    if (this.isActive) throw conflict("SERVER_RUNNING", `Server is ${this.state.status}`);
    const { paths, logs, state, profiles, library, worlds } = this.deps;

    const persisted = await state.get();
    const id = profileId ?? persisted.activeProfileId ?? (await profiles.ensureDefault()).id;
    const profile = await profiles.get(id);

    await this.preflight();

    // 1. World junction.
    await worlds.link(profile.world);
    logs.note(`profile "${profile.name}" (${profile.id}); world "${profile.world}"`);

    // 2. Mods: rebuild data/server/mods from the library.
    const libraryFiles = new Set((await library.list()).map((m) => m.file));
    const existing = await fs.readdir(paths.serverMods).catch(() => [] as string[]);
    const plan = planMods(
      profile.enabledMods,
      libraryFiles,
      paths.modLibrary,
      paths.serverMods,
      existing,
    );
    const applied = await applyModPlan(plan);
    logs.note(
      `mods: ${plan.link.length} enabled (${applied.linked} linked, ${applied.copied} copied)`,
    );
    for (const m of plan.missing) logs.note(`WARNING: enabled mod missing from library: ${m}`);

    // 3. server.properties from template + profile overrides + forced keys.
    const template = await fs.readFile(
      path.join(paths.templates, "server.properties.default"),
      "utf8",
    );
    const built = buildServerProperties(template, profile.properties);
    await fs.writeFile(path.join(paths.server, "server.properties"), built.text, "utf8");
    this.lastEffectiveProperties = built.effective;

    // 4. Log file for this launch.
    await pruneLogFiles(paths.logs, "server", KEEP_LOG_FILES - 1);
    this.logFile = new LogFile(paths.logs, "server");
    await this.logFile.open();

    // 5. Spawn.
    const args = this.jvmArgs(profile);
    const spawnSpec = this.deps.spawnOverride ?? { javaPath: this.deps.javaPath, args };
    this.lastJvmArgs = spawnSpec.args;
    const proc = new JavaProcess();
    this.proc = proc;
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
    proc.on("error", (err: Error) => {
      logs.note(`spawn error: ${err.message}`);
      this.finish(null, `spawn error: ${err.message}`);
    });
    proc.on("exit", (code: number | null) => this.finish(code, null));

    logs.note(`launching: ${spawnSpec.javaPath} ${spawnSpec.args.join(" ")}`);
    proc.start({ javaPath: spawnSpec.javaPath, args: spawnSpec.args, cwd: paths.server });
    this.setState({ pid: proc.pid });

    this.readyTimer = setTimeout(() => {
      if (this.state.status === "starting") {
        logs.note(`still starting after ${READY_TIMEOUT_MS / 60000} min; check the log for a hang`);
      }
    }, READY_TIMEOUT_MS);
    return this.getState();
  }

  async stop(): Promise<ServerState> {
    const proc = this.proc;
    if (!proc || !proc.alive || !this.isActive) return this.getState();
    if (this.state.status !== "stopping") {
      this.setState({ status: "stopping" });
      this.deps.logs.note("sending stop");
      proc.write("stop");
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(async () => {
        this.deps.logs.note(`no exit after ${STOP_TIMEOUT_MS / 1000}s; killing`);
        await proc.kill();
      }, STOP_TIMEOUT_MS);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      if (!proc.alive) done();
      else proc.once("exit", done);
    });
    return this.getState();
  }

  async restart(): Promise<ServerState> {
    const id = this.state.activeProfileId ?? undefined;
    await this.stop();
    return this.start(id);
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
    this.deps.logs.push("daemon", `> ${command}`);
    proc.write(command);
  }

  /** For process.on("exit"): the daemon is dying, take the server with it rather than orphan it. */
  killSync(): void {
    this.proc?.killSync();
  }

  // ---- internals -------------------------------------------------------------------------

  private async preflight(): Promise<void> {
    const { paths, javaPath } = this.deps;
    if (this.deps.spawnOverride) return;
    if (!(await eulaAccepted(paths.server))) {
      throw conflict("EULA_REQUIRED", "Accept the Minecraft EULA before starting");
    }
    if (!(await launcherPresent(paths.server))) {
      throw conflict("LAUNCHER_MISSING", "Fabric server launcher not downloaded yet");
    }
    const java = await probeJava(javaPath);
    if (!java.ok) {
      throw conflict(
        "JAVA_UNSUPPORTED",
        `Java at ${javaPath} is ${java.version ?? "missing"}; need 25+`,
      );
    }
  }

  private jvmArgs(profile: Profile): string[] {
    const gb = Math.max(1, Math.round(profile.jvm.maxMemoryGb));
    return [
      `-Xms${Math.min(gb, 2)}G`,
      `-Xmx${gb}G`,
      // Player names and chat can be non-ASCII; without these Windows Java writes cp1252.
      "-Dfile.encoding=UTF-8",
      "-Dstdout.encoding=UTF-8",
      ...profile.jvm.extraArgs,
      "-jar",
      launcherJarPath(this.deps.paths.server),
      // Without nogui the server opens a Swing window and stops writing to stdout.
      "nogui",
    ];
  }

  private onLine(stream: "stdout" | "stderr", text: string): void {
    const line = this.deps.logs.push(stream, text);
    this.logFile?.write(line);
    switch (line.kind) {
      case "done":
        if (this.state.status === "starting") {
          this.setState({ status: "running", readyAt: new Date().toISOString() });
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
        this.setState({ lastStopReason: "EULA not accepted (eula.txt)" });
        break;
      case "crash":
        if (!this.state.lastStopReason) this.setState({ lastStopReason: line.text.slice(0, 200) });
        break;
    }
  }

  private finish(code: number | null, reason: string | null): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    const wasStopping = this.state.status === "stopping";
    const crashed = !wasStopping && code !== 0;
    const stopReason =
      reason ??
      this.state.lastStopReason ??
      (wasStopping ? "stopped by request" : crashed ? `exited with code ${code}` : "exited");
    this.deps.logs.note(`server process exited (code ${code}); ${stopReason}`);
    this.setState({
      status: crashed ? "crashed" : "stopped",
      pid: null,
      players: [],
      lastExitCode: code,
      lastStopReason: stopReason,
    });
    void this.logFile?.close();
    this.logFile = null;
    this.proc = null;
  }

  private setState(patch: Partial<ServerState>): void {
    this.state = { ...this.state, ...patch };
    this.emit("state", this.getState());
  }
}
