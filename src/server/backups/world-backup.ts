import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { ZipArchive } from "archiver";
import type { Profile, ServerState, WorldBackupStatus } from "../../shared/types.ts";
import type { Paths } from "../config.ts";
import { conflict } from "../errors.ts";
import { exists, readJson, writeJsonAtomic } from "../fsx.ts";
import type { LogBuffer } from "../process/log-buffer.ts";
import type { ServerManager } from "../process/server-manager.ts";
import type { ProfileStore } from "../profiles/profile-store.ts";
import type { RuntimeStore } from "../runtime/runtime-store.ts";
import type { WorldStore } from "../worlds/world-store.ts";
import { fileHash } from "./backup-service.ts";

/** One entry of `<runtime>/backups/backups.json`, the FTB Backups 2 manifest shape. */
export interface ManifestEntry {
  worldName: string;
  createTime: number;
  backupLocation: string;
  size: number;
  sha1: string;
  backupName: string;
  backupFormat: string;
  complete: boolean;
}

export interface WorldBackupDeps {
  paths: Paths;
  logs: LogBuffer;
  server: ServerManager;
  profiles: ProfileStore;
  worlds: WorldStore;
  runtimes: RuntimeStore;
  /** Called after each archive is published, so the mirror copies it without waiting a minute. */
  onBackup?: () => void;
}

/** Marks entries this service owns. FTB writes the same manifest; its entries are never pruned here. */
const OWNER = "mineserver";
const DEFAULT_INTERVAL_MINUTES = 30;
const DEFAULT_KEEP = 5;
const TICK_MS = 60_000;

/** FTB Backups 2 already produces archives; running both would race on backups.json. */
export const hasFtbBackups = (profile: Profile): boolean =>
  profile.enabledMods.some((m) => /^ftb-?backups/i.test(m));

/** FTB's unpadded local-time name, which the mirror's filename filter expects. */
export function archiveName(d: Date): string {
  return (
    `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}_` +
    `${d.getHours()}-${d.getMinutes()}-${d.getSeconds()}.zip`
  );
}

/**
 * Periodic world backups for profiles that lack a backup mod (every Fabric profile today).
 * Archives land where FTB would put them, so BackupService mirrors them unchanged and
 * `npm run backup:verify` restores them. While zipping, Minecraft's autosave is off and the world
 * has just been flushed, so region files are not rewritten underneath the archive.
 */
export class WorldBackupService {
  private intervalMs = DEFAULT_INTERVAL_MINUTES * 60_000;
  private keep = DEFAULT_KEEP;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<ManifestEntry> | null = null;
  /** Players have been online since the last archive. An idle world is not re-archived. */
  private dirty = false;
  private lastAt = 0;
  private state: WorldBackupStatus = {
    enabled: false,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    keep: DEFAULT_KEEP,
    busy: false,
    lastFile: null,
    lastAt: null,
    lastError: null,
    skippedReason: null,
  };
  private onState = (s: ServerState) => {
    if (s.status === "running" && s.players.length > 0) this.dirty = true;
  };

  constructor(private readonly deps: WorldBackupDeps) {}

  async init(): Promise<void> {
    const config = await readJson<{
      worldBackupIntervalMinutes?: number;
      worldBackupKeep?: number;
    }>(path.join(this.deps.paths.data, "reliability.json"), {});
    const minutes = config.worldBackupIntervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
    // 0 disables. Anything under 5 minutes would spend most of the session with autosave off.
    this.state.enabled = minutes > 0;
    this.state.intervalMinutes = minutes > 0 ? Math.max(5, minutes) : 0;
    this.intervalMs = this.state.intervalMinutes * 60_000;
    this.keep = this.state.keep = Math.max(1, Math.floor(config.worldBackupKeep ?? DEFAULT_KEEP));
  }

  start(): void {
    if (this.timer || !this.state.enabled) return;
    this.deps.server.on("state", this.onState);
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.deps.server.off("state", this.onState);
    await this.running?.catch(() => undefined);
  }

  status(): WorldBackupStatus {
    return { ...this.state };
  }

  /** One scheduler step; the interval calls it every minute. Exposed for tests. */
  async tick(): Promise<void> {
    const s = this.deps.server.getState();
    if (s.status !== "running" || this.running) return;
    if (s.players.length > 0) this.dirty = true;
    if (!this.dirty || Date.now() - this.lastAt < this.intervalMs || !s.activeProfileId) return;
    const profile = await this.deps.profiles.get(s.activeProfileId).catch(() => null);
    if (!profile) return;
    if (hasFtbBackups(profile)) {
      this.state.skippedReason = "FTB Backups handles this profile";
      return;
    }
    await this.backup().catch(() => undefined); // recorded in state.lastError
  }

  /** Archive the running server's world now. Rejects if another backup is in progress. */
  backup(): Promise<ManifestEntry> {
    if (this.running) throw conflict("BACKUP_RUNNING", "A world backup is already in progress");
    const hadPlayers = this.deps.server.getState().players.length > 0;
    this.running = this.backupInternal()
      .then((entry) => {
        this.dirty = hadPlayers;
        this.lastAt = Date.now();
        this.state.lastFile = path.basename(entry.backupLocation);
        this.state.lastAt = new Date(entry.createTime).toISOString();
        this.state.lastError = null;
        return entry;
      })
      .catch((err: unknown) => {
        // Retry on the next tick only after a full interval, so a persistent failure (disk full)
        // does not toggle autosave off and on every minute.
        this.lastAt = Date.now();
        this.state.lastError = err instanceof Error ? err.message : String(err);
        this.deps.logs.note(`world backup failed: ${this.state.lastError}`);
        throw err;
      })
      .finally(() => {
        this.running = null;
        this.state.busy = false;
      });
    return this.running;
  }

  private async backupInternal(): Promise<ManifestEntry> {
    const { server, profiles, worlds, runtimes, logs } = this.deps;
    const s = server.getState();
    if (s.status !== "running" || !s.activeProfileId)
      throw conflict("SERVER_NOT_RUNNING", "Server is not running");
    const profile = await profiles.get(s.activeProfileId);
    if (hasFtbBackups(profile)) {
      this.state.skippedReason = "FTB Backups handles this profile";
      throw conflict("BACKUP_BY_MOD", "This profile's FTB Backups mod makes its world backups");
    }
    this.state.skippedReason = null;
    this.state.busy = true;
    const worldDir = worlds.worldPath(profile.world);
    const dir = path.join(runtimes.paths(profile.runtime).dir, "backups");
    await fs.mkdir(dir, { recursive: true });
    // Names have one-second resolution; a manual backup right after a scheduled one must not
    // overwrite it, so step forward to a free name.
    let created = new Date();
    while (await exists(path.join(dir, archiveName(created))))
      created = new Date(created.getTime() + 1000);
    const file = path.join(dir, archiveName(created));
    const part = `${file}.part`;

    // A stop or crash mid-archive means Java may be writing its final save into the files being
    // read. Such an archive is discarded rather than published as a good backup.
    let interrupted = false;
    const watch = (st: ServerState) => {
      if (st.status !== "running") interrupted = true;
    };
    server.on("state", watch);
    let autosaveOff = false;
    try {
      server.send("save-off");
      autosaveOff = true;
      await server.save();
      await zipWorld(worldDir, profile.world, part);
    } catch (err) {
      await fs.rm(part, { force: true });
      throw err;
    } finally {
      server.off("state", watch);
      // Minecraft re-enables saving for its own shutdown save, so a failure here loses nothing.
      if (autosaveOff) {
        try {
          server.send("save-on");
        } catch {
          interrupted = true;
        }
      }
    }
    if (interrupted) {
      await fs.rm(part, { force: true });
      throw conflict("SERVER_NOT_RUNNING", "Server stopped during the backup; archive discarded");
    }

    const sha1 = await fileHash(part);
    const { size } = await fs.stat(part);
    await fs.rename(part, file);
    const entry: ManifestEntry = {
      worldName: profile.world,
      createTime: created.getTime(),
      backupLocation: file,
      size,
      sha1,
      backupName: OWNER,
      backupFormat: "zip",
      complete: true,
    };
    await this.record(dir, entry);
    logs.note(`world backup: ${path.basename(file)} (${(size / 1024 ** 2).toFixed(1)} MiB)`);
    this.deps.onBackup?.();
    return entry;
  }

  /** Append to the manifest and prune this world's oldest mineserver archives beyond `keep`. */
  private async record(dir: string, entry: ManifestEntry): Promise<void> {
    const manifestFile = path.join(dir, "backups.json");
    const manifest = await readJson<{ backups?: ManifestEntry[] }>(manifestFile, {});
    const all = [...(manifest.backups ?? []), entry];
    const ours = all
      .filter((b) => b.backupName === OWNER && b.worldName === entry.worldName)
      .sort((a, b) => b.createTime - a.createTime);
    const drop = new Set(ours.slice(this.keep));
    for (const b of drop) {
      const name = path.basename(b.backupLocation);
      // Only ever delete a plain archive name inside this backups dir.
      if (name.endsWith(".zip")) await fs.rm(path.join(dir, name), { force: true });
    }
    await writeJsonAtomic(manifestFile, { ...manifest, backups: all.filter((b) => !drop.has(b)) });
  }
}

/** Entries are `<world>/...`, the root restore.ts accepts. session.lock is held open by Java. */
async function zipWorld(worldDir: string, world: string, out: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(out, { flags: "wx" });
    // Region files are already compressed; a light level keeps the autosave-off window short.
    const archive = new ZipArchive({ zlib: { level: 1 } });
    stream.on("close", resolve);
    stream.on("error", reject);
    archive.on("error", reject);
    archive.on("warning", reject);
    archive.pipe(stream);
    archive.directory(worldDir, world, (entry) =>
      path.basename(entry.name) === "session.lock" ? false : entry,
    );
    void archive.finalize();
  });
}
