import { spawn, execFile, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";

export interface SpawnOptions {
  javaPath: string;
  args: string[];
  cwd: string;
}

/**
 * Thin wrapper around the Java child: line-split stdout/stderr, stdin writes, and a hard-kill
 * that kills the process tree on Windows. `child.kill()` alone only signals java.exe; taskkill /T
 * is the safe default in case the launcher ever forks.
 */
export class JavaProcess extends EventEmitter {
  private child: ChildProcess | null = null;
  private exited = false;

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get alive(): boolean {
    return this.child !== null && !this.exited;
  }

  start(opts: SpawnOptions): void {
    if (this.child) throw new Error("JavaProcess already started");
    // Always an argv array, never a shell string: paths with spaces (C:\Program Files\Java).
    const child = spawn(opts.javaPath, opts.args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      detached: false,
    });
    this.child = child;
    const wire = (stream: NodeJS.ReadableStream | null, name: "stdout" | "stderr") => {
      if (!stream) return;
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on("line", (line) => this.emit("line", name, line));
    };
    wire(child.stdout, "stdout");
    wire(child.stderr, "stderr");
    child.on("error", (err) => this.emit("error", err));
    child.on("exit", (code, signal) => {
      this.exited = true;
      this.emit("exit", code, signal);
    });
  }

  write(line: string): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || !this.alive) return false;
    stdin.write(line.endsWith("\n") ? line : `${line}\n`);
    return true;
  }

  /** Synchronous variant for process.on("exit"), where nothing async ever runs. */
  killSync(): void {
    const pid = this.pid;
    if (!pid || !this.alive) return;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      this.child?.kill("SIGKILL");
    }
  }

  /** Force-kill the whole tree. Resolves when the OS call returns, not when exit fires. */
  async kill(): Promise<void> {
    const pid = this.pid;
    if (!pid || !this.alive) return;
    if (process.platform === "win32") {
      await new Promise<void>((resolve) =>
        execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => resolve()),
      );
    } else {
      this.child?.kill("SIGKILL");
    }
  }
}
