import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exists } from "./fsx.ts";

/**
 * Repo root is two levels above this file in both layouts:
 *   src/server/config.ts (tsx dev) and dist/server/config.js (built).
 */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface Paths {
  root: string;
  data: string;
  server: string;
  serverMods: string;
  /** Junction target for the active world; server.properties always says level-name=world. */
  serverWorldLink: string;
  serverLogs: string;
  serverCrashReports: string;
  worlds: string;
  modLibrary: string;
  modLibraryIndex: string;
  profiles: string;
  logs: string;
  playit: string;
  exports: string;
  stateFile: string;
  templates: string;
  minecraftDir: string;
  minecraftSaves: string;
  minecraftMods: string;
  clientSyncManifest: string;
}

export function resolvePaths(dataDir?: string): Paths {
  const data = path.resolve(dataDir ?? process.env.MINESERVER_DATA ?? path.join(repoRoot, "data"));
  const server = path.join(data, "server");
  const minecraftDir =
    process.env.MINESERVER_MINECRAFT_DIR ??
    (process.platform === "win32"
      ? path.join(
          process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
          ".minecraft",
        )
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support", "minecraft")
        : path.join(os.homedir(), ".minecraft"));
  return {
    root: repoRoot,
    data,
    server,
    serverMods: path.join(server, "mods"),
    serverWorldLink: path.join(server, "world"),
    serverLogs: path.join(server, "logs"),
    serverCrashReports: path.join(server, "crash-reports"),
    worlds: path.join(data, "worlds"),
    modLibrary: path.join(data, "mods", "library"),
    modLibraryIndex: path.join(data, "mods", "library.json"),
    profiles: path.join(data, "profiles"),
    logs: path.join(data, "logs"),
    playit: path.join(data, "playit"),
    exports: path.join(data, "exports"),
    stateFile: path.join(data, "state.json"),
    templates: path.join(repoRoot, "templates"),
    minecraftDir,
    minecraftSaves: path.join(minecraftDir, "saves"),
    minecraftMods: path.join(minecraftDir, "mods"),
    clientSyncManifest: path.join(data, "client-sync-manifest.json"),
  };
}

export async function ensureDirs(p: Paths): Promise<void> {
  const dirs = [
    p.data,
    p.server,
    p.serverMods,
    p.worlds,
    p.modLibrary,
    p.profiles,
    p.logs,
    p.playit,
    p.exports,
  ];
  for (const dir of dirs) await fs.mkdir(dir, { recursive: true });
}

/**
 * Find a Java 25+ binary. JAVA_HOME is deliberately ignored: on the dev machine it points at
 * JDK 17 while PATH resolves to 25. Order: MINESERVER_JAVA env, then the newest
 * "C:\Program Files\Java\jdk-*", then bare "java" on PATH.
 */
export async function findJava(): Promise<string> {
  if (process.env.MINESERVER_JAVA) return process.env.MINESERVER_JAVA;
  if (process.platform === "win32") {
    const roots = ["C:\\Program Files\\Java", "C:\\Program Files\\Eclipse Adoptium"];
    const candidates: { major: number; exe: string }[] = [];
    for (const root of roots) {
      const entries = await fs.readdir(root).catch(() => [] as string[]);
      for (const name of entries) {
        const m = /^jdk-?(\d+)/.exec(name);
        if (!m) continue;
        const exe = path.join(root, name, "bin", "java.exe");
        if (await exists(exe)) candidates.push({ major: Number(m[1]), exe });
      }
    }
    candidates.sort((a, b) => b.major - a.major);
    if (candidates.length > 0) return candidates[0].exe;
  }
  return "java";
}
