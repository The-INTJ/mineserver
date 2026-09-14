import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { LogLine } from "../../shared/types.ts";
import { LOG_RING_SIZE } from "../../shared/constants.ts";
import { classify } from "./log-classify.ts";

/**
 * In-memory ring of recent log lines with monotonic `seq`, so SSE clients can resume with
 * `?since=`. The Java process, the daemon's own notes, and playit all push here.
 */
export class LogBuffer extends EventEmitter {
  readonly sessionId = randomUUID();
  private lines: LogLine[] = [];
  private nextSeq = 1;

  constructor(private readonly capacity = LOG_RING_SIZE) {
    super();
    this.setMaxListeners(100);
  }

  push(stream: LogLine["stream"], text: string): LogLine {
    text = text.slice(0, 32768);
    const c = classify(text);
    const line: LogLine = {
      seq: this.nextSeq++,
      ts: new Date().toISOString(),
      stream,
      text,
      level: c.level,
      kind: c.kind,
      ...(c.player ? { player: c.player } : {}),
    };
    this.lines.push(line);
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
    this.emit("line", line);
    return line;
  }

  /** Daemon-originated note, shown inline with server output. */
  note(text: string): LogLine {
    return this.push("daemon", `[mineserver] ${text}`);
  }

  since(seq: number): LogLine[] {
    return this.lines.filter((l) => l.seq > seq);
  }

  tail(n: number, grep?: RegExp): LogLine[] {
    const src = grep ? this.lines.filter((l) => grep.test(l.text)) : this.lines;
    return src.slice(Math.max(0, src.length - n));
  }

  get lastSeq(): number {
    return this.nextSeq - 1;
  }
}
