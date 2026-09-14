import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { LogLine } from "../../shared/types.ts";

/** Bounded asynchronous capture. Disk failures degrade diagnostics, never crash the game. */
export class LogFile {
  readonly file: string;
  private handle: FileHandle | null = null;
  private queue: string[] = [];
  private queuedBytes = 0;
  private bytes = 0;
  private pumping: Promise<void> | null = null;
  private closing = false;
  private opened = false;
  error: string | null = null;
  constructor(
    logsDir: string,
    prefix = "server",
    private readonly onError = (text: string) => console.error(text),
    private readonly maxBytes = 16 * 1024 * 1024,
  ) {
    this.file = path.join(
      logsDir,
      `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
    );
  }
  async open(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    this.handle = await fs.open(this.file, "a");
    this.bytes = (await this.handle.stat()).size;
    this.opened = true;
  }
  write(line: LogLine): void {
    if (!this.opened || this.closing || this.error) return;
    const text = `${line.ts} [${line.stream}] ${line.text.slice(0, 32768)}\n`;
    if (this.queuedBytes + Buffer.byteLength(text) > 1024 * 1024) {
      this.fail(new Error("Log capture queue exceeded 1 MiB; capture disabled"));
      return;
    }
    this.queue.push(text);
    this.queuedBytes += Buffer.byteLength(text);
    if (!this.pumping)
      this.pumping = this.pump().finally(() => {
        this.pumping = null;
      });
  }
  private async pump(): Promise<void> {
    try {
      while (this.queue.length && this.handle && !this.error) {
        const text = this.queue.shift()!;
        this.queuedBytes -= Buffer.byteLength(text);
        if (this.bytes >= this.maxBytes) {
          await this.handle.close();
          this.handle = null;
          await fs.rm(`${this.file}.3.log`, { force: true });
          for (let n = 2; n >= 0; n--) {
            const from = n ? `${this.file}.${n}.log` : this.file;
            await fs
              .rename(from, `${this.file}.${n + 1}.log`)
              .catch((err: NodeJS.ErrnoException) => {
                if (err.code !== "ENOENT") throw err;
              });
          }
          this.handle = await fs.open(this.file, "a");
          this.bytes = 0;
        }
        await this.handle.writeFile(text);
        this.bytes += Buffer.byteLength(text);
      }
    } catch (err) {
      this.fail(err);
    }
  }
  private fail(err: unknown): void {
    if (this.error) return;
    this.error = `Log capture degraded: ${String(err)}`;
    this.queue = [];
    this.queuedBytes = 0;
    this.onError(this.error);
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.pumping;
    const handle = this.handle;
    this.handle = null;
    await handle?.close().catch((err: unknown) => this.fail(err));
  }
}
export async function pruneLogFiles(logsDir: string, prefix: string, keep: number): Promise<void> {
  const names = (await fs.readdir(logsDir).catch(() => [] as string[]))
    .filter((n) => n.startsWith(`${prefix}-`) && n.endsWith(".log") && !/\.log\.\d\.log$/.test(n))
    .sort();
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    for (const suffix of ["", ".1.log", ".2.log", ".3.log"])
      await fs.rm(path.join(logsDir, name + suffix), { force: true });
  }
}
