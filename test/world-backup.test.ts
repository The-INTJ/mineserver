import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fileHash } from "../src/server/backups/backup-service.ts";
import { verifyRestore } from "../src/server/backups/restore.ts";
import { archiveName, type ManifestEntry } from "../src/server/backups/world-backup.ts";
import { createContext, type AppContext } from "../src/server/context.ts";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-java.mjs");

const until = async (cond: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
};

let root: string;
let ctx: AppContext | undefined;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mineserver-worldbackup-"));
});
afterEach(async () => {
  await ctx?.worldBackups.stop();
  await ctx?.server.dispose();
  ctx = undefined;
  if (!path.resolve(root).startsWith(path.join(os.tmpdir(), "mineserver-worldbackup-")))
    throw new Error("Unsafe test cleanup");
  await fs.rm(root, { recursive: true, force: true });
});

const dataDir = () => path.join(root, "data");
const backupsDir = () => path.join(dataDir(), "servers", "fabric-26.2", "backups");
const manifest = async () =>
  (
    JSON.parse(await fs.readFile(path.join(backupsDir(), "backups.json"), "utf8")) as {
      backups: ManifestEntry[];
    }
  ).backups;

async function running(config: Record<string, unknown> = {}) {
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(
    path.join(dataDir(), "reliability.json"),
    JSON.stringify({ backupDirectory: path.join(root, "mirror"), ...config }),
  );
  ctx = await createContext({
    dataDir: dataDir(),
    stopTimeoutMs: 500,
    spawnOverride: { javaPath: process.execPath, args: [FAKE] },
  });
  const world = path.join(dataDir(), "worlds", "default");
  await fs.mkdir(path.join(world, "region"), { recursive: true });
  await fs.writeFile(path.join(world, "level.dat"), "level");
  await fs.writeFile(path.join(world, "region", "r.0.0.mca"), Buffer.alloc(64 * 1024, 7));
  await fs.writeFile(path.join(world, "session.lock"), "☃");
  await ctx.server.start();
  await until(() => ctx!.server.getState().status === "running");
  return ctx;
}

it("archives the world with autosave paused, in FTB's format, and mirrors it", async () => {
  const c = await running();
  const entry = await c.worldBackups.backup();
  const file = path.basename(entry.backupLocation);
  expect(file).toMatch(/^\d{4}-\d{1,2}-\d{1,2}_\d{1,2}-\d{1,2}-\d{1,2}\.zip$/);
  expect(await fileHash(entry.backupLocation)).toBe(entry.sha1);
  expect(await manifest()).toEqual([entry]);
  expect(entry).toMatchObject({ worldName: "default", complete: true, backupName: "mineserver" });
  await expect(fs.stat(`${entry.backupLocation}.part`)).rejects.toThrow();

  // Autosave was off for the whole archive and is back on afterwards.
  const text = c.logs.tail(50).map((l) => l.text);
  const at = (s: string) => text.findIndex((t) => t.includes(s));
  expect(at("Automatic saving is now disabled")).toBeGreaterThan(-1);
  expect(at("Saved the game")).toBeGreaterThan(at("Automatic saving is now disabled"));
  expect(at("Automatic saving is now enabled")).toBeGreaterThan(at("Saved the game"));

  // The restore verifier accepts it, and the Java-held session.lock is left out.
  const restored = path.join(root, "restore-check");
  await verifyRestore(entry.backupLocation, "default", restored);
  expect(await fs.readFile(path.join(restored, "level.dat"), "utf8")).toBe("level");
  expect((await fs.stat(path.join(restored, "region", "r.0.0.mca"))).size).toBe(64 * 1024);
  await expect(fs.stat(path.join(restored, "session.lock"))).rejects.toThrow();

  await until(() => c.backups.status().copies === 1);
  expect(c.backups.status().lastError).toBeNull();
  expect(c.worldBackups.status()).toMatchObject({ lastFile: file, lastError: null, busy: false });
});

it("keeps the newest archives per world and never prunes FTB's entries", async () => {
  const c = await running({ worldBackupKeep: 2 });
  await fs.mkdir(backupsDir(), { recursive: true });
  const ftb = {
    worldName: "default",
    createTime: 1,
    backupLocation: path.join(backupsDir(), "2020-1-1_0-0-0.zip"),
    sha1: "0".repeat(40),
    complete: true,
  };
  await fs.writeFile(path.join(backupsDir(), "backups.json"), JSON.stringify({ backups: [ftb] }));
  const made: ManifestEntry[] = [];
  for (let i = 0; i < 3; i++) made.push(await c.worldBackups.backup());
  // Same-second backups step forward to distinct names instead of overwriting.
  expect(new Set(made.map((m) => m.backupLocation)).size).toBe(3);
  const kept = await manifest();
  expect(kept.map((b) => b.backupLocation)).toEqual([
    ftb.backupLocation,
    made[1].backupLocation,
    made[2].backupLocation,
  ]);
  await expect(fs.stat(made[0].backupLocation)).rejects.toThrow();
  expect((await fs.readdir(backupsDir())).filter((f) => f.endsWith(".zip"))).toHaveLength(2);
});

it("leaves profiles with FTB Backups alone and does not toggle autosave", async () => {
  const c = await running();
  await c.profiles.update("default", { enabledMods: ["ftbbackups2-forge-1.20-1.0.23.jar"] });
  await expect(c.worldBackups.backup()).rejects.toMatchObject({ code: "BACKUP_BY_MOD" });
  expect(c.logs.tail(50).some((l) => l.text.includes("Automatic saving"))).toBe(false);
  expect(c.worldBackups.status().skippedReason).toMatch(/FTB/);
});

it("discards the archive when the server stops mid-backup", async () => {
  const c = await running();
  // Stop exactly when the flush is acknowledged, i.e. while the world is being zipped.
  let stopped: Promise<unknown> | null = null;
  const onLine = (line: { text: string }) => {
    if (!stopped && line.text.includes("Saved the game")) stopped = c.server.stop();
  };
  c.logs.on("line", onLine);
  await expect(c.worldBackups.backup()).rejects.toThrow(/archive discarded/);
  c.logs.off("line", onLine);
  await stopped;
  const files = await fs.readdir(backupsDir());
  expect(files.filter((f) => f.endsWith(".zip") || f.endsWith(".part"))).toEqual([]);
  await expect(fs.stat(path.join(backupsDir(), "backups.json"))).rejects.toThrow();
  await expect(c.worldBackups.backup()).rejects.toMatchObject({ code: "SERVER_NOT_RUNNING" });
});

it("schedules backups only after players have been online", async () => {
  const c = await running();
  await c.worldBackups.tick();
  await expect(fs.readdir(backupsDir())).rejects.toThrow(); // idle world: nothing archived
  c.server.send("join");
  await until(() => c.server.getState().players.length === 1);
  await c.worldBackups.tick();
  expect(await manifest()).toHaveLength(1);
  await c.worldBackups.tick(); // within the interval
  expect(await manifest()).toHaveLength(1);
});

it("names archives the way FTB does", () => {
  expect(archiveName(new Date(2026, 9, 6, 20, 5, 0))).toBe("2026-10-6_20-5-0.zip");
});
