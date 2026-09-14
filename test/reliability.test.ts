import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BackupService, fileHash } from "../src/server/backups/backup-service.ts";
import { restoreEntryPath, verifyRestore } from "../src/server/backups/restore.ts";
import { resolvePaths, ensureDirs } from "../src/server/config.ts";
import { createContext, type AppContext } from "../src/server/context.ts";
import { createApp } from "../src/server/app.ts";
import { LogFile } from "../src/server/process/log-file.ts";
import { acquireInstanceLock } from "../src/server/process/instance-lock.ts";
import { makeJar } from "./make-jar.ts";
import { TunnelManager } from "../src/server/tunnel/tunnel.ts";
import { PlayitProvider } from "../src/server/tunnel/playit-provider.ts";
import { LogBuffer } from "../src/server/process/log-buffer.ts";

let root: string;
let ctx: AppContext | undefined;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mineserver-reliability-"));
});
afterEach(async () => {
  await ctx?.server.dispose();
  ctx = undefined;
  if (!path.resolve(root).startsWith(path.join(os.tmpdir(), "mineserver-reliability-")))
    throw new Error("Unsafe test cleanup");
  await fs.rm(root, { recursive: true, force: true });
});

it("mirrors only complete checksum-valid archives and reports corruption without touching sources", async () => {
  const paths = resolvePaths(path.join(root, "data"));
  await ensureDirs(paths);
  const mirror = path.join(root, "copies");
  await fs.writeFile(
    path.join(paths.data, "reliability.json"),
    JSON.stringify({ backupDirectory: mirror }),
  );
  const source = path.join(paths.servers, "forge-1.20.1", "backups");
  await fs.mkdir(source, { recursive: true });
  const file = "2026-9-13_23-0-0.zip";
  await makeJar(path.join(source, file), { "world/level.dat": "saved world" });
  const sha1 = await fileHash(path.join(source, file));
  const backup = {
    complete: false,
    backupLocation: path.join(source, file),
    sha1,
    createTime: Date.now(),
  };
  const writeManifest = () =>
    fs.writeFile(path.join(source, "backups.json"), JSON.stringify({ backups: [backup] }));
  await writeManifest();
  const service = new BackupService(paths);
  await service.init();
  await service.scan();
  expect(service.status().copies).toBe(0);
  backup.complete = true;
  await writeManifest();
  await Promise.all([service.scan(), service.scan()]);
  expect(service.status().lastError).toBeNull();
  expect(service.status().copies).toBe(1);
  expect(await fileHash(path.join(mirror, "forge-1.20.1", file))).toBe(sha1);
  const corrupt = "2026-9-13_23-30-0.zip";
  await fs.writeFile(path.join(source, corrupt), "corrupt");
  backup.backupLocation = path.join(source, corrupt);
  await writeManifest();
  await service.scan();
  expect(service.status().lastError).toContain("checksum mismatch");
  expect(await fs.readFile(path.join(source, corrupt), "utf8")).toBe("corrupt");
  expect(await fs.stat(path.join(mirror, "forge-1.20.1", corrupt)).catch(() => null)).toBeNull();
});

it("restores to a new folder, verifies contents and refuses to overwrite an existing world", async () => {
  const archive = path.join(root, "backup.zip");
  await makeJar(archive, { "world/level.dat": "saved", "world/region/r.0.0.mca": "chunks" });
  const dest = path.join(root, "restore");
  const result = await verifyRestore(archive, "world", dest);
  expect(result.files).toBe(2);
  expect(await fs.readFile(path.join(dest, "region/r.0.0.mca"), "utf8")).toBe("chunks");
  await expect(verifyRestore(archive, "world", dest)).rejects.toThrow();
  expect(await fs.readFile(path.join(dest, "level.dat"), "utf8")).toBe("saved");
});

it("recognizes FTB's legacy archive prefix but rejects traversal, reserved names and other worlds", () => {
  expect(restoreEntryPath("..\\..\\worlds\\sunlit-valley\\level.dat", "sunlit-valley")).toBe(
    "level.dat",
  );
  for (const name of [
    "../../worlds/other/level.dat",
    "../../worlds/sunlit-valley/../level.dat",
    "sunlit-valley/region/../../escape",
    "sunlit-valley/C:/file",
    "sunlit-valley/CON.txt",
    "sunlit-valley/region./file",
    "/absolute/file",
  ])
    expect(() => restoreEntryPath(name, "sunlit-valley")).toThrow();
});

it("detects CRC-corrupted archive entries", async () => {
  const archive = path.join(root, "bad.zip");
  await makeJar(archive, { "world/level.dat": "saved" });
  const bytes = await fs.readFile(archive);
  const header = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt32LE((bytes.readUInt32LE(header + 16) ^ 1) >>> 0, header + 16);
  await fs.writeFile(archive, bytes);
  await expect(verifyRestore(archive, "world", path.join(root, "restore"))).rejects.toThrow(
    "CRC mismatch",
  );
});

it("does not lose lines arriving while a log rotates", async () => {
  const log = new LogFile(root, "server", () => undefined, 2500);
  await log.open();
  for (let n = 0; n < 100; n++) {
    log.write({
      seq: n,
      ts: "2026-09-14T00:00:00Z",
      stream: "daemon",
      text: `message-${n}`,
      kind: "other",
      level: "INFO",
    });
    if (n % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await log.close();
  const all = (
    await Promise.all(
      (await fs.readdir(root)).map((name) => fs.readFile(path.join(root, name), "utf8")),
    )
  ).join("");
  expect(all.match(/message-\d+\n/g)).toHaveLength(100);
  expect(log.error).toBeNull();
});

it("holds an exclusive data-directory lock and releases it on close", async () => {
  const lock = await acquireInstanceLock(root);
  try {
    await expect(acquireInstanceLock(root)).rejects.toThrow();
  } finally {
    await new Promise<void>((resolve) => lock.close(() => resolve()));
  }
  const next = await acquireInstanceLock(root);
  await new Promise<void>((resolve) => next.close(() => resolve()));
});

it("contains a missing Playit executable as a tunnel error", async () => {
  const provider = new PlayitProvider(root, new LogBuffer());
  vi.spyOn(provider, "secretPresent").mockResolvedValue(true);
  await expect(provider.start()).rejects.toThrow();
  expect(provider.lastError).toContain("Playit process failed");
  expect(provider.running).toBe(false);
  await provider.stop();
});

it("does not present a saved external address as verified connectivity", async () => {
  const tunnel = new TunnelManager(root, new LogBuffer());
  await tunnel.init();
  await tunnel.setMode("external", "existing.example:25565");
  expect((await tunnel.getState()).status).toBe("configured");
});

it("serializes tunnel starts, preserves its known address and cancels an in-flight start", async () => {
  await fs.writeFile(
    path.join(root, "tunnel.json"),
    JSON.stringify({ mode: "playit", tunnelId: "known", publicAddress: "existing.example:25565" }),
  );
  const tunnel = new TunnelManager(root, new LogBuffer());
  await tunnel.init();
  const prepare = vi.spyOn(tunnel.playit, "prepareTunnel");
  let finishStart: (() => void) | undefined;
  const start = vi.spyOn(tunnel.playit, "start").mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishStart = resolve;
      }),
  );
  const stop = vi.spyOn(tunnel.playit, "stop").mockResolvedValue();
  const first = tunnel.start();
  const second = tunnel.start();
  const ending = tunnel.stop();
  finishStart!();
  await Promise.all([first, second, ending]);
  expect(start).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(prepare).not.toHaveBeenCalled();
  expect((await tunnel.getState()).publicAddress).toBe("existing.example:25565");
});

it("reads compressed logs as text and rejects oversized filters", async () => {
  ctx = await createContext({ dataDir: path.join(root, "data") });
  const logs = path.join(ctx.paths.servers, "fabric-26.2", "logs");
  await fs.mkdir(logs, { recursive: true });
  await fs.writeFile(
    path.join(logs, "archived.log.gz"),
    gzipSync("saving players\nAll dimensions are saved\n"),
  );
  const app = createApp(ctx);
  const response = await app.request("/api/logs/files/server/archived.log.gz");
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("All dimensions are saved");
  expect((await app.request(`/api/logs?grep=${"a".repeat(300)}`)).status).toBe(400);
  ctx.logs.note("a literal (a+)+ string");
  const filtered = await app.request("/api/logs?grep=" + encodeURIComponent("(a+)+"));
  expect((await filtered.json()).lines).toHaveLength(1);
});
