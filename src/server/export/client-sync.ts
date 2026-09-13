import { promises as fs } from "node:fs";
import path from "node:path";
import type { ClientSyncResult, ModEntry, Profile } from "../../shared/types.ts";
import { exists, readJson, writeJsonAtomic } from "../fsx.ts";
import { clientSideMods } from "./client-zip.ts";

interface SyncManifest {
  /** Jar filenames mineserver placed in the client mods dir. Only these are ever removed. */
  placed: string[];
}

/**
 * Copy the profile's client-side jars into %APPDATA%\.minecraft\mods. Copy, not hardlink: the
 * client dir is on a different volume (EXDEV). Files we did not place (Sodium, zoom, whatever
 * the user added by hand) are never touched; the manifest is the only source of "ours".
 */
export async function syncClientMods(opts: {
  profile: Profile;
  library: ModEntry[];
  libraryDir: string;
  clientModsDir: string;
  manifestFile: string;
}): Promise<ClientSyncResult> {
  const { include } = clientSideMods(opts.profile, opts.library);
  const desired = new Set(include.map((m) => m.file));
  const manifest = await readJson<SyncManifest>(opts.manifestFile, { placed: [] });
  await fs.mkdir(opts.clientModsDir, { recursive: true });

  const removed: string[] = [];
  for (const file of manifest.placed) {
    if (desired.has(file)) continue;
    const p = path.join(opts.clientModsDir, file);
    if (await exists(p)) {
      await fs.rm(p, { force: true });
      removed.push(file);
    }
  }

  const copied: string[] = [];
  for (const file of desired) {
    await fs.copyFile(path.join(opts.libraryDir, file), path.join(opts.clientModsDir, file));
    copied.push(file);
  }

  await writeJsonAtomic(opts.manifestFile, { placed: [...desired].sort() } satisfies SyncManifest);
  return { copied, removed, targetDir: opts.clientModsDir };
}
