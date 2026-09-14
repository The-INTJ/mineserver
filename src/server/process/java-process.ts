import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

export interface SpawnOptions {
  javaPath: string;
  args: string[];
  cwd: string;
}

/** Guardian owns Java and saves on manager loss; this wrapper owns its IPC connection. */
export class JavaProcess extends EventEmitter {
  private child: ChildProcess | null = null;
  private javaPid: number | null = null;
  private exited = false;
  get pid(): number | null {
    return this.javaPid;
  }
  get alive(): boolean {
    return this.child !== null && !this.exited;
  }

  async prepare(cwd: string, receipt: string): Promise<void> {
    if (this.child) throw new Error("JavaProcess already prepared");
    const script = fileURLToPath(new URL("../../../tools/java-guardian.mjs", import.meta.url));
    const child = fork(script, [cwd, receipt], {
      execArgv: [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      detached: true,
      ...{ windowsHide: true },
    });
    this.child = child;
    child.stderr?.on("data", (data: Buffer) => this.emit("line", "stderr", data.toString()));
    child.on("error", (err) => this.emit("warning", err.message));
    child.on(
      "message",
      (message: {
        type: string;
        pid?: number;
        text?: string;
        stream?: string;
        code?: number | null;
        signal?: string | null;
      }) => {
        if (message.type === "started") this.javaPid = message.pid ?? null;
        if (message.type === "line") this.emit("line", message.stream, message.text);
        if (message.type === "warning" || message.type === "error")
          this.emit("warning", message.text);
        if (message.type === "closed") this.finish(message.code ?? null, message.signal ?? null);
      },
    );
    child.on("close", (code, signal) => this.finish(code, signal));
    // A detached Windows child's inherited pipes may delay `close` after IPC is severed.
    // The guardian writes its receipt only after Java closes, before the guardian itself exits.
    child.on("exit", (code, signal) => this.finish(code, signal));
    await this.waitFor("prepared");
  }
  async start(opts: SpawnOptions, stopTimeoutMs = 60000): Promise<void> {
    const ready = this.waitFor("started");
    this.post({ type: "launch", javaPath: opts.javaPath, args: opts.args, stopTimeoutMs });
    await ready;
  }
  private waitFor(type: string): Promise<void> {
    const child = this.child!;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new Error(`Guardian ${type} timed out`)), 10000);
      const onMessage = (message: { type: string; text?: string }) => {
        if (message.type === type) done();
        if (message.type === "error") done(new Error(message.text));
      };
      const onClose = () => done(new Error(`Guardian closed before ${type}`));
      const done = (err?: Error) => {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("close", onClose);
        child.off("exit", onClose);
        if (err) reject(err);
        else resolve();
      };
      child.on("message", onMessage);
      child.once("close", onClose);
      child.once("exit", onClose);
    });
  }
  private post(message: object): boolean {
    if (!this.child?.connected || this.exited) return false;
    this.child.send(message, (err) => {
      if (err) this.emit("warning", err.message);
    });
    return true;
  }
  write(line: string): boolean {
    return this.post({ type: "command", line });
  }
  requestStop(reason = "requested stop"): void {
    this.post({ type: "stop", reason });
  }
  // Exit hooks sever IPC; guardian stays alive to save and stop Java.
  killSync(): void {
    if (this.child?.connected) this.child.disconnect();
  }
  async kill(): Promise<void> {
    this.post({ type: "force" });
  }
  waitForExit(timeoutMs = 75000): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("exit", done);
        reject(new Error("Guardian has not exited; runtime ownership retained"));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once("exit", done);
    });
  }
  private finish(code: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, signal);
  }
}
