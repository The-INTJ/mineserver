import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { PLAYIT_SIZE_BYTES, PLAYIT_URL, PLAYIT_VERSION } from "../../shared/constants.ts";
import { conflict } from "../errors.ts";
import { exists } from "../fsx.ts";
import type { LogBuffer } from "../process/log-buffer.ts";
import {
  parseAddressFromAgentLog,
  parseClaimCode,
  parseClaimUrl,
  parseSecret,
  parseTunnelsList,
} from "./playit-parse.ts";

export interface ClaimProgress {
  code: string;
  url: string;
  startedAt: string;
  /** Resolved when `claim exchange` returns. */
  result: "pending" | "done" | "error";
  error?: string;
}

/**
 * Drives the pinned playit agent binary under data/playit. Three concerns, kept separate:
 *   install  = download the exe (only after the user confirms in the UI),
 *   claim    = one-time browser approval that yields the secret (headless via claim generate/url/exchange),
 *   run      = the agent child process that actually relays 25565.
 */
export class PlayitProvider {
  readonly exe: string;
  readonly secretFile: string;
  private agent: ChildProcess | null = null;
  private claim: ClaimProgress | null = null;
  private exchange: ChildProcess | null = null;
  private addressFromLog: string | null = null;
  private starting: Promise<void> | null = null;
  private intentionalStop = false;
  lastError: string | null = null;

  constructor(
    private readonly dir: string,
    private readonly logs: LogBuffer,
  ) {
    this.exe = path.join(dir, `playit-${PLAYIT_VERSION}.exe`);
    this.secretFile = path.join(dir, "playit.toml");
  }

  get pid(): number | null {
    return this.agent?.pid ?? null;
  }

  get running(): boolean {
    return this.agent !== null && this.agent.exitCode === null;
  }

  get lastLoggedAddress(): string | null {
    return this.addressFromLog;
  }

  binaryPresent(): Promise<boolean> {
    return exists(this.exe);
  }

  secretPresent(): Promise<boolean> {
    return exists(this.secretFile);
  }

  claimProgress(): ClaimProgress | null {
    return this.claim;
  }

  async install(): Promise<{ file: string; bytes: number }> {
    if (process.platform !== "win32") {
      throw conflict("PLAYIT_PLATFORM", "Auto-install only handles Windows; use external mode");
    }
    const res = await fetch(PLAYIT_URL, { redirect: "follow" });
    if (!res.ok) throw new Error(`playit download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (Math.abs(buf.length - PLAYIT_SIZE_BYTES) > PLAYIT_SIZE_BYTES * 0.5) {
      throw new Error(
        `playit download size ${buf.length} is far from expected ${PLAYIT_SIZE_BYTES}`,
      );
    }
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(`${this.exe}.part`, buf);
    await fs.rename(`${this.exe}.part`, this.exe);
    return { file: this.exe, bytes: buf.length };
  }

  /** Step 1+2 of the claim: get a code, turn it into a URL for the user, kick off the exchange. */
  async startClaim(): Promise<ClaimProgress> {
    if (this.claim?.result === "pending") return this.claim;
    const codeOut = await this.run(["claim", "generate"], false);
    const code = parseClaimCode(codeOut);
    if (!code) throw new Error(`could not parse claim code from: ${codeOut.trim()}`);
    const urlOut = await this.run(["claim", "url", code, "--name", "mineserver"], false);
    const url = parseClaimUrl(urlOut);
    if (!url) throw new Error(`could not parse claim URL from: ${urlOut.trim()}`);
    const progress: ClaimProgress = {
      code,
      url,
      startedAt: new Date().toISOString(),
      result: "pending",
    };
    this.claim = progress;

    // `claim exchange --wait N` blocks until the user approves in the browser (or N seconds).
    const child = spawn(this.exe, ["claim", "exchange", code, "--wait", "600"], {
      windowsHide: true,
    });
    this.exchange = child;
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) =>
      this.logs.push("daemon", `[playit claim] ${d.toString("utf8").trim()}`),
    );
    child.on("error", (err) => {
      this.exchange = null;
      progress.result = "error";
      progress.error = `Claim process failed: ${err.message}`;
    });
    child.on("close", (code) => {
      void (async () => {
        this.exchange = null;
        const secret = parseSecret(out);
        if (code === 0 && secret) {
          // Same shape the agent writes itself, so `--secret_path` reads it back.
          await fs.writeFile(this.secretFile, `secret_key = "${secret}"\n`, "utf8");
          progress.result = "done";
          this.logs.note("playit agent claimed; secret stored under data/playit");
        } else {
          progress.result = "error";
          progress.error = `claim exchange exited ${code}: ${out.trim().slice(-300)}`;
          this.logs.note(`playit claim failed: ${progress.error}`);
        }
      })().catch((err: unknown) => {
        progress.result = "error";
        progress.error = `Claim could not be saved: ${String(err)}`;
        this.logs.note(progress.error);
      });
    });
    return progress;
  }

  async prepareTunnel(): Promise<{ id: string; address: string } | null> {
    // Idempotent: creates the tunnel only if one with this name doesn't exist yet.
    await this.run(
      ["tunnels", "prepare", "tcp", "1", "--type", "minecraft-java", "--name", "mineserver"],
      true,
    );
    const list = parseTunnelsList(await this.run(["tunnels", "list"], true));
    const t = list.find((e) => e.portType.toLowerCase().includes("tcp")) ?? list[0];
    return t ? { id: t.id, address: t.address } : null;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.starting) return this.starting;
    this.starting = this.startInternal();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startInternal(): Promise<void> {
    this.intentionalStop = false;
    this.lastError = null;
    if (!(await this.secretPresent()))
      throw conflict("PLAYIT_UNCLAIMED", "Claim the playit agent first");
    const args = ["--secret_path", this.secretFile, "--stdout", "start"];
    this.logs.note(`starting playit agent: ${path.basename(this.exe)} ${args.join(" ")}`);
    const child = spawn(this.exe, args, {
      cwd: this.dir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.agent = child;
    const wire = (s: NodeJS.ReadableStream | null) => {
      if (!s) return;
      readline.createInterface({ input: s }).on("line", (line) => {
        this.logs.push("daemon", `[playit] ${line}`);
        const addr = parseAddressFromAgentLog(line);
        if (addr) this.addressFromLog = addr;
      });
    };
    wire(child.stdout);
    wire(child.stderr);
    child.on("error", (err) => {
      this.lastError = `Playit process failed: ${err.message}`;
      this.logs.note(this.lastError);
      if (this.agent === child) this.agent = null;
    });
    child.on("close", (code) => {
      this.logs.note(`playit agent exited (code ${code})`);
      if (!this.intentionalStop)
        this.lastError ??= `Playit agent exited (code ${code}); restart it from the Tunnel tab`;
      if (this.agent === child) this.agent = null;
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }

  async stop(): Promise<void> {
    await this.starting?.catch(() => undefined);
    this.intentionalStop = true;
    const a = this.agent;
    if (!a || a.exitCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        a.off("exit", done);
        reject(new Error("Playit did not stop within 10 seconds"));
      }, 10000);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      a.once("exit", done);
      if (process.platform === "win32") {
        execFile(
          "taskkill",
          ["/pid", String(a.pid), "/T", "/F"],
          { windowsHide: true },
          () => undefined,
        );
      } else {
        a.kill("SIGTERM");
      }
    });
  }

  killSync(): void {
    const a = this.agent;
    if (!a || a.exitCode !== null) return;
    if (process.platform === "win32") {
      // spawnSync would be cleaner but taskkill here is best-effort during process exit.
      execFile(
        "taskkill",
        ["/pid", String(a.pid), "/T", "/F"],
        { windowsHide: true },
        () => undefined,
      );
    } else {
      a.kill("SIGKILL");
    }
  }

  /** Run a one-shot CLI command and capture stdout. */
  private run(args: string[], withSecret: boolean): Promise<string> {
    const full = withSecret ? ["--secret_path", this.secretFile, ...args] : args;
    return new Promise((resolve, reject) => {
      execFile(
        this.exe,
        full,
        { cwd: this.dir, windowsHide: true, timeout: 60_000 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`playit ${args.join(" ")} failed: ${err.message}\n${stderr}`));
            return;
          }
          resolve(stdout);
        },
      );
    });
  }
}
