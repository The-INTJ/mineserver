import path from "node:path";
import type { Loader, Runtime } from "../../shared/types.ts";
import { FABRIC_INSTALLER_VERSION } from "../../shared/constants.ts";

/** Pure knowledge about runtimes: ids, URLs, Java requirements, launch commands. No I/O. */

export function runtimeId(rt: Runtime): string {
  return `${rt.loader}-${rt.minecraft}`;
}

export function parseRuntimeId(id: string): { loader: Loader; minecraft: string } | null {
  const m = /^(fabric|forge|neoforge)-(.+)$/.exec(id);
  return m ? { loader: m[1] as Loader, minecraft: m[2] } : null;
}

/**
 * Java major required by a Minecraft version. Mojang's actual history:
 *   ≤1.16 → 8, 1.17 → 16, 1.18–1.20.4 → 17, 1.20.5–1.21.x → 21, 26.x (the new year-based scheme) → 25.
 */
export function javaMajorFor(minecraft: string): number {
  const parts = minecraft.split(".").map((p) => Number.parseInt(p, 10));
  const [a, b = 0, c = 0] = parts;
  if (!Number.isFinite(a)) return 25;
  if (a >= 26) return 25;
  if (a === 25) return 21;
  // 1.x line
  if (b >= 21) return 21;
  if (b === 20) return c >= 5 ? 21 : 17;
  if (b >= 18) return 17;
  if (b === 17) return 16;
  return 8;
}

export interface InstallSpec {
  /** What to download. */
  url: string;
  /** Filename to save it as inside the runtime dir. */
  file: string;
  /** "launcher": the download *is* the server bootstrap. "installer": run `java -jar <file> --installServer`. */
  kind: "launcher" | "installer";
}

export function installSpec(rt: Runtime): InstallSpec {
  switch (rt.loader) {
    case "fabric":
      return {
        url: `https://meta.fabricmc.net/v2/versions/loader/${rt.minecraft}/${rt.loaderVersion}/${FABRIC_INSTALLER_VERSION}/server/jar`,
        file: "fabric-server-launch.jar",
        kind: "launcher",
      };
    case "forge": {
      const v = `${rt.minecraft}-${rt.loaderVersion}`;
      return {
        url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${v}/forge-${v}-installer.jar`,
        file: `forge-${v}-installer.jar`,
        kind: "installer",
      };
    }
    case "neoforge":
      return {
        url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${rt.loaderVersion}/neoforge-${rt.loaderVersion}-installer.jar`,
        file: `neoforge-${rt.loaderVersion}-installer.jar`,
        kind: "installer",
      };
  }
}

/** The file whose presence means "installed" for this runtime, relative to the runtime dir. */
export function installedMarker(rt: Runtime): string {
  switch (rt.loader) {
    case "fabric":
      return "fabric-server-launch.jar";
    case "forge":
      return path.join(
        "libraries",
        "net",
        "minecraftforge",
        "forge",
        `${rt.minecraft}-${rt.loaderVersion}`,
        process.platform === "win32" ? "win_args.txt" : "unix_args.txt",
      );
    case "neoforge":
      return path.join(
        "libraries",
        "net",
        "neoforged",
        "neoforge",
        rt.loaderVersion,
        process.platform === "win32" ? "win_args.txt" : "unix_args.txt",
      );
  }
}

/**
 * Java args after the memory/encoding flags. Forge/NeoForge ≥1.17 ship an args file the installer
 * writes (module path, main class, etc.); `@file` expansion is a java launcher feature.
 */
export function launchArgs(rt: Runtime, runtimeDir: string): string[] {
  switch (rt.loader) {
    case "fabric":
      return ["-jar", path.join(runtimeDir, "fabric-server-launch.jar"), "nogui"];
    case "forge":
    case "neoforge":
      // Relative path on purpose: the args file itself contains paths relative to the cwd.
      return [`@${installedMarker(rt).split(path.sep).join("/")}`, "nogui"];
  }
}

/** Which library jars can load on this runtime. Jars with no parsed manifest are allowed but flagged in the UI. */
export function loaderCompatible(jarLoaders: readonly string[] | undefined, rt: Runtime): boolean {
  if (!jarLoaders || jarLoaders.length === 0) return true;
  return jarLoaders.includes(rt.loader);
}

/**
 * How the active world reaches the server dir.
 *   "junction":   <runtime>/world is a directory junction to data/worlds/<name> (level-name=world).
 *   "level-name": no link; level-name is a relative path into data/worlds. Needed on 1.20.x/1.21.x:
 *                 their DirectoryValidator reads the path with NOFOLLOW_LINKS, and Java reports a
 *                 Windows junction as "other" (not a symlink, not a directory), so the server
 *                 refuses it with "Path .\world is not a directory" regardless of allowed_symlinks.
 *                 26.x accepts the junction, so Fabric keeps the link (verified on both).
 */
export function worldMode(rt: Runtime): "junction" | "level-name" {
  return rt.loader === "fabric" ? "junction" : "level-name";
}
