import { createWriteStream, promises as fs, type WriteStream } from "node:fs";
import path from "node:path";
import type { LogLine } from "../../shared/types.ts";

/** One append-only file per launch under data/logs; the game's own logs stay in data/server/logs. */
export class LogFile {
  private stream: WriteStream | null = null;
  readonly file: string;

  constructor(logsDir: string, prefix = "server") {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.file = path.join(logsDir, `${prefix}-${stamp}.log`);
  }

  async open(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    this.stream = createWriteStream(this.file, { flags: "a" });
  }

  write(line: LogLine): void {
    this.stream?.write(`${line.ts} [${line.stream}] ${line.text}\n`);
  }

  async close(): Promise<void> {
    const s = this.stream;
    this.stream = null;
    if (!s) return;
    await new Promise<void>((resolve) => s.end(resolve));
  }
}

/** Keep at most `keep` files matching `prefix-*.log`, deleting the oldest. */
export async function pruneLogFiles(logsDir: string, prefix: string, keep: number): Promise<void> {
  const names = (await fs.readdir(logsDir).catch(() => [] as string[]))
    .filter((n) => n.startsWith(`${prefix}-`) && n.endsWith(".log"))
    .sort();
  for (const n of names.slice(0, Math.max(0, names.length - keep))) {
    await fs.rm(path.join(logsDir, n), { force: true });
  }
}
