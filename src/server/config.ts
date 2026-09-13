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
  /** One server working dir per runtime lives under here: data/servers/<loader>-<mc>/ */
  servers: string;
  worlds: string;
  modLibrary: string;
  modLibraryIndex: string;
  modpacks: string;
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

/** Everything inside one runtime's server working dir. */
export interface RuntimePaths {
  dir: string;
  mods: string;
  /** Junction to data/worlds/<active>; server.properties always says level-name=world. */
  worldLink: string;
  logs: string;
  crashReports: string;
  eula: string;
  properties: string;
}

export function runtimePaths(serversRoot: string, runtimeId: string): RuntimePaths {
  const dir = path.join(serversRoot, runtimeId);
  return {
    dir,
    mods: path.join(dir, "mods"),
    worldLink: path.join(dir, "world"),
    logs: path.join(dir, "logs"),
    crashReports: path.join(dir, "crash-reports"),
    eula: path.join(dir, "eula.txt"),
    properties: path.join(dir, "server.properties"),
  };
}

export function resolvePaths(dataDir?: string): Paths {
  const data = path.resolve(dataDir ?? process.env.MINESERVER_DATA ?? path.join(repoRoot, "data"));
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
    servers: path.join(data, "servers"),
    worlds: path.join(data, "worlds"),
    modLibrary: path.join(data, "mods", "library"),
    modLibraryIndex: path.join(data, "mods", "library.json"),
    modpacks: path.join(data, "modpacks"),
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
    p.servers,
    p.worlds,
    p.modLibrary,
    p.modpacks,
    p.profiles,
    p.logs,
    p.playit,
    p.exports,
  ];
  for (const dir of dirs) await fs.mkdir(dir, { recursive: true });
  // v0.1 kept a single server at data/server; it was always Fabric 26.2.
  const legacy = path.join(p.data, "server");
  const target = path.join(p.servers, "fabric-26.2");
  if ((await exists(legacy)) && !(await exists(target))) await fs.rename(legacy, target);
}

export interface JavaCandidate {
  major: number;
  exe: string;
}

/**
 * Enumerate installed JDKs. JAVA_HOME is deliberately ignored: on the dev machine it points at
 * JDK 17 while PATH resolves to 25. Order: MINESERVER_JAVA_<major> env, then "C:\Program Files\Java\jdk-*"
 * and Adoptium, then bare "java" on PATH as a last resort with unknown major.
 */
export async function listJavas(): Promise<JavaCandidate[]> {
  const out: JavaCandidate[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    const m = /^MINESERVER_JAVA_(\d+)$/.exec(k);
    if (m && v) out.push({ major: Number(m[1]), exe: v });
  }
  if (process.platform === "win32") {
    const roots = [
      "C:\\Program Files\\Java",
      "C:\\Program Files\\Eclipse Adoptium",
      "C:\\Program Files\\Microsoft",
    ];
    for (const root of roots) {
      const entries = await fs.readdir(root).catch(() => [] as string[]);
      for (const name of entries) {
        const m = /^jdk-?(\d+)/.exec(name);
        if (!m) continue;
        const exe = path.join(root, name, "bin", "java.exe");
        if (await exists(exe)) out.push({ major: Number(m[1]), exe });
      }
    }
  } else {
    for (const root of ["/usr/lib/jvm", "/Library/Java/JavaVirtualMachines"]) {
      const entries = await fs.readdir(root).catch(() => [] as string[]);
      for (const name of entries) {
        const m = /(\d+)/.exec(name);
        if (!m) continue;
        for (const rel of ["bin/java", "Contents/Home/bin/java"]) {
          const exe = path.join(root, name, rel);
          if (await exists(exe)) out.push({ major: Number(m[1]), exe });
        }
      }
    }
  }
  return out.sort((a, b) => b.major - a.major);
}

/**
 * Pick a JDK for a required major. Exact match first; otherwise the closest *newer* one. The
 * caller decides whether "newer" is acceptable (it is for Fabric on 26.x; Forge 1.20.1 on 25 breaks).
 */
export function pickJava(candidates: JavaCandidate[], major: number): JavaCandidate | null {
  const exact = candidates.find((c) => c.major === major);
  if (exact) return exact;
  const newer = candidates.filter((c) => c.major > major).sort((a, b) => a.major - b.major);
  return newer[0] ?? null;
}
