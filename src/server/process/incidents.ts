import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RunRecord } from "../../shared/types.ts";
import { readJson, writeJsonAtomic } from "../fsx.ts";

/** Small durable per-launch records; continuous output has its own rotated log. */
export class IncidentStore {
  current: RunRecord | null = null;
  error: string | null = null;
  private pending = Promise.resolve();
  constructor(readonly dir: string) {}
  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    this.current = (await this.list())[0] ?? null;
    if (this.current && !this.current.endedAt) {
      const receipt = await readJson<Partial<RunRecord> | null>(
        this.receiptFile(this.current.id),
        null,
      );
      if (receipt?.endedAt) {
        this.current = {
          ...this.current,
          endedAt: receipt.endedAt,
          code: receipt.code ?? null,
          signal: receipt.signal ?? null,
          saveConfirmedAt: receipt.saveConfirmedAt ?? null,
          forced: receipt.forced ?? false,
          reason: receipt.reason ?? "guardian completed shutdown",
          outcome: receipt.forced ? "forced" : receipt.code === 0 ? "stopped" : "crashed",
        };
      } else {
        this.current = {
          ...this.current,
          outcome: "unclean",
          reason:
            "Previous manager ended without a completion record; cause unknown. Guardian may still be saving.",
        };
      }
      await this.persist();
    }
  }
  async begin(profileId: string, runtime: string): Promise<RunRecord> {
    this.current = {
      id: `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
      profileId,
      runtime,
      startedAt: new Date().toISOString(),
      readyAt: null,
      endedAt: null,
      pid: null,
      code: null,
      signal: null,
      reason: null,
      outcome: "starting",
      forced: false,
      saveConfirmedAt: null,
      lagWarnings: 0,
      worstLagMs: 0,
      logFile: null,
    };
    await this.persist();
    return this.current;
  }
  patch(update: Partial<RunRecord>): Promise<void> {
    if (!this.current) return Promise.resolve();
    this.current = { ...this.current, ...update };
    return this.persist();
  }
  private persist(): Promise<void> {
    if (!this.current) return Promise.resolve();
    const record = structuredClone(this.current);
    this.pending = this.pending
      .then(() => writeJsonAtomic(path.join(this.dir, `${record.id}.json`), record))
      .catch((err: unknown) => {
        this.error = `Incident storage unavailable: ${String(err)}`;
        console.error(this.error);
      });
    return this.pending;
  }
  receiptFile(id: string): string {
    return path.join(this.dir, `${id}.guardian.json`);
  }
  async flush(): Promise<void> {
    await this.pending;
  }
  async list(): Promise<RunRecord[]> {
    const names = (await fs.readdir(this.dir).catch(() => [] as string[]))
      .filter((name) => name.endsWith(".json") && !name.endsWith(".guardian.json"))
      .sort()
      .reverse();
    const records = await Promise.all(
      names
        .slice(0, 50)
        .map((name) =>
          readJson<RunRecord | null>(path.join(this.dir, name), null).catch(() => null),
        ),
    );
    return records.filter((r): r is RunRecord => r !== null);
  }
}
