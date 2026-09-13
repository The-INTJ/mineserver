import { ZipArchive } from "archiver";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import type { ExportResult, ModEntry, Profile } from "../../shared/types.ts";
import { LOADER_VERSION, MC_VERSION } from "../../shared/constants.ts";

export interface ExportOptions {
  profile: Profile;
  library: ModEntry[];
  libraryDir: string;
  exportsDir: string;
  templatesDir: string;
  serverAddress: string | null;
}

/** Which of a profile's enabled mods a *client* needs: everything not server-only. */
export function clientSideMods(
  profile: Profile,
  library: ModEntry[],
): { include: ModEntry[]; excluded: ModEntry[] } {
  const byFile = new Map(library.map((m) => [m.file, m]));
  const include: ModEntry[] = [];
  const excluded: ModEntry[] = [];
  for (const file of profile.enabledMods) {
    const m = byFile.get(file);
    if (!m) continue;
    if (m.environment === "server") excluded.push(m);
    else include.push(m);
  }
  return { include, excluded };
}

export async function exportClientZip(opts: ExportOptions): Promise<ExportResult> {
  const { include, excluded } = clientSideMods(opts.profile, opts.library);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const file = `${opts.profile.id}-client-${stamp}.zip`;
  const dest = path.join(opts.exportsDir, file);
  await fs.mkdir(opts.exportsDir, { recursive: true });

  const readme = (await fs.readFile(path.join(opts.templatesDir, "client-readme.txt"), "utf8"))
    .replaceAll("{{profileName}}", opts.profile.name)
    .replaceAll("{{minecraftVersion}}", MC_VERSION)
    .replaceAll("{{loaderVersion}}", LOADER_VERSION)
    .replaceAll("{{serverAddress}}", opts.serverAddress ?? "(ask the host)")
    .replaceAll("{{generatedAt}}", new Date().toISOString())
    .replaceAll(
      "{{modList}}",
      include.map((m) => `  * ${m.name} ${m.version} (${m.file})`).join("\n"),
    );

  const manifest = {
    generatedBy: "mineserver",
    generatedAt: new Date().toISOString(),
    profile: { id: opts.profile.id, name: opts.profile.name },
    minecraft: MC_VERSION,
    fabricLoader: LOADER_VERSION,
    serverAddress: opts.serverAddress,
    mods: include.map((m) => ({
      file: m.file,
      id: m.id,
      version: m.version,
      environment: m.environment,
    })),
    excludedServerOnly: excluded.map((m) => m.file),
  };

  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(dest);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    out.on("close", resolve);
    out.on("error", reject);
    archive.on("error", reject);
    archive.pipe(out);
    for (const m of include)
      archive.file(path.join(opts.libraryDir, m.file), { name: `mods/${m.file}` });
    archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
    archive.append(readme, { name: "README.txt" });
    void archive.finalize();
  });

  return {
    file,
    sizeBytes: (await fs.stat(dest)).size,
    includedMods: include.map((m) => m.file),
    excludedServerOnly: excluded.map((m) => m.file),
  };
}
