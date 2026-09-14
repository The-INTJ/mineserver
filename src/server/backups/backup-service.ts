import { createReadStream, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Paths } from "../config.ts";
import { readJson, writeJsonAtomic } from "../fsx.ts";

interface MirrorRecord {
  file: string;
  sha1: string;
  copiedAt: string;
}
export interface BackupHealth {
  enabled: boolean;
  directory: string | null;
  lastSuccessAt: string | null;
  lastBackupAt: string | null;
  lastError: string | null;
  copies: number;
  busy: boolean;
  restoreVerifiedAt: string | null;
}
export async function fileHash(file: string, algorithm = "sha1"): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Mirrors finalized FTB archives, never live world files. Source backups are never removed. */
export class BackupService {
  private state: BackupHealth = {
    enabled: false,
    directory: null,
    lastSuccessAt: null,
    lastBackupAt: null,
    lastError: null,
    copies: 0,
    busy: false,
    restoreVerifiedAt: null,
  };
  private timer: NodeJS.Timeout | null = null;
  private pending: Promise<void> | null = null;
  constructor(private readonly paths: Paths) {}
  async init(): Promise<void> {
    const config = await readJson<{ backupDirectory?: string }>(
      path.join(this.paths.data, "reliability.json"),
      {},
    );
    const stored = await readJson<Partial<BackupHealth>>(
      path.join(this.paths.data, "backup-health.json"),
      {},
    );
    this.state = {
      ...this.state,
      ...stored,
      enabled: !!config.backupDirectory,
      directory: config.backupDirectory ? path.resolve(config.backupDirectory) : null,
      busy: false,
    };
    if (this.state.directory) {
      const relative = path.relative(this.paths.data, this.state.directory);
      if (
        !relative ||
        (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
      )
        throw new Error("Backup mirror must be outside the server data directory");
    }
  }
  start(): void {
    if (this.timer || !this.state.enabled) return;
    void this.scan();
    this.timer = setInterval(() => void this.scan(), 60000);
    this.timer.unref();
  }
  status(): BackupHealth {
    return { ...this.state };
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.pending;
  }
  scan(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.scanInternal().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  private async scanInternal(): Promise<void> {
    const destination = this.state.directory;
    if (!destination) return;
    this.state.busy = true;
    try {
      await fs.mkdir(destination, { recursive: true });
      let copies = 0;
      for (const runtime of await fs.readdir(this.paths.servers)) {
        const source = path.join(this.paths.servers, runtime, "backups");
        const manifest = await readJson<{
          backups?: {
            complete?: boolean;
            backupLocation: string;
            sha1: string;
            createTime: number;
          }[];
        }>(path.join(source, "backups.json"), {});
        const targetDir = path.join(destination, runtime);
        await fs.mkdir(targetDir, { recursive: true });
        const indexFile = path.join(targetDir, "mirror.json");
        let index = await readJson<MirrorRecord[]>(indexFile, []);
        for (const backup of manifest.backups ?? []) {
          if (!backup.complete || !/^[0-9a-f]{40}$/i.test(backup.sha1)) continue;
          const file = path.basename(backup.backupLocation);
          if (!/^\d{4}-\d{1,2}-\d{1,2}_\d{1,2}-\d{1,2}-\d{1,2}\.zip$/.test(file)) continue;
          const origin = path.join(source, file);
          const dest = path.join(targetDir, file);
          this.state.lastBackupAt = new Date(
            Math.max(Date.parse(this.state.lastBackupAt ?? "1970-01-01"), backup.createTime),
          ).toISOString();
          if (
            index.some((r) => r.file === file && r.sha1 === backup.sha1) &&
            (await fs.stat(dest).then(
              (s) => s.size > 0,
              () => false,
            ))
          )
            continue;
          const stat = await fs.stat(origin);
          const space = await fs.statfs(targetDir);
          if (space.bavail * space.bsize < stat.size + 2 * 1024 ** 3)
            throw new Error("Backup destination needs 2 GiB free reserve");
          await fs.copyFile(origin, `${dest}.part`);
          if ((await fileHash(`${dest}.part`)) !== backup.sha1.toLowerCase())
            throw new Error(`Backup checksum mismatch: ${file}`);
          await fs.rename(`${dest}.part`, dest);
          index = index.filter((r) => r.file !== file);
          index.push({ file, sha1: backup.sha1, copiedAt: new Date().toISOString() });
          await writeJsonAtomic(indexFile, index);
          this.state.lastSuccessAt = new Date().toISOString();
        }
        // Retain 48 newest plus one per each of the seven most recent calendar days. Only delete files
        // already recorded as copies owned by this service; baseline backups are elsewhere.
        index.sort((a, b) => b.copiedAt.localeCompare(a.copiedAt));
        const keep = new Set(index.slice(0, 48).map((r) => r.file));
        const days = new Set<string>();
        for (const r of index) {
          const day = r.file.split("_")[0];
          if (!days.has(day) && days.size < 7) {
            keep.add(r.file);
            days.add(day);
          }
        }
        for (const r of index)
          if (!keep.has(r.file)) {
            if (path.basename(r.file) !== r.file || !r.file.endsWith(".zip"))
              throw new Error("Invalid mirror index path");
            await fs.rm(path.join(targetDir, r.file), { force: true });
          }
        index = index.filter((r) => keep.has(r.file));
        await writeJsonAtomic(indexFile, index);
        copies += index.length;
      }
      this.state.copies = copies;
      this.state.lastError = null;
    } catch (err) {
      this.state.lastError = String(err);
    } finally {
      this.state.busy = false;
      await writeJsonAtomic(path.join(this.paths.data, "backup-health.json"), this.state).catch(
        (err: unknown) => console.error("Backup health persistence:", err),
      );
    }
  }
}
