import { ZipArchive } from "archiver";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import type { ExportResult, ModEntry, Profile } from "../../shared/types.ts";
import { exists } from "../fsx.ts";
import { listMrpackJarNames } from "../mods/mrpack.ts";

export interface ExportOptions {
  profile: Profile;
  library: ModEntry[];
  libraryDir: string;
  modpacksDir: string;
  exportsDir: string;
  templatesDir: string;
  serverAddress: string | null;
}

/**
 * Which jars a *client* needs for this profile: enabled mods that aren't server-only, plus the
 * profile's client-only extras.
 */
export function clientSideMods(
  profile: Profile,
  library: ModEntry[],
): { include: ModEntry[]; excluded: ModEntry[] } {
  const byFile = new Map(library.map((m) => [m.file, m]));
  const include: ModEntry[] = [];
  const excluded: ModEntry[] = [];
  const seen = new Set<string>();
  for (const file of [...profile.enabledMods, ...profile.clientMods]) {
    if (seen.has(file)) continue;
    seen.add(file);
    const m = byFile.get(file);
    if (!m) continue;
    if (m.environment === "server") excluded.push(m);
    else include.push(m);
  }
  return { include, excluded };
}

/**
 * For modpack profiles the friend installs the .mrpack itself (it's included in the zip), so
 * only jars added on top of the pack ship loose in mods/.
 */
export async function exportClientZip(opts: ExportOptions): Promise<ExportResult> {
  const { profile } = opts;
  const { include, excluded } = clientSideMods(profile, opts.library);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const file = `${profile.id}-client-${stamp}.zip`;
  const dest = path.join(opts.exportsDir, file);
  await fs.mkdir(opts.exportsDir, { recursive: true });

  const mrpackPath = profile.modpack ? path.join(opts.modpacksDir, profile.modpack.file) : null;
  const mrpackPresent = mrpackPath ? await exists(mrpackPath) : false;
  let looseJars = include;
  if (mrpackPath && mrpackPresent) {
    // Everything the launcher installs from the .mrpack itself (indexed downloads AND
    // overrides/mods) must not ship loose too, or the friend ends up with duplicates.
    const packJars = new Set(await listMrpackJarNames(mrpackPath));
    looseJars = include.filter((m) => !packJars.has(m.file));
  }

  const loaderName = { fabric: "Fabric", forge: "Forge", neoforge: "NeoForge" }[
    profile.runtime.loader
  ];
  const modpackSection = profile.modpack
    ? [
        `This profile runs the modpack "${profile.modpack.name}" ${profile.modpack.version}.`,
        mrpackPresent
          ? `  * The pack file ${profile.modpack.file} is included in this zip.`
          : `  * Get it from ${profile.modpack.source}`,
        "  * Install it with the Modrinth App (https://modrinth.app), Prism Launcher, or any launcher",
        "    that imports .mrpack files. It sets up the right Minecraft/loader version for you.",
        looseJars.length > 0
          ? "  * Then drop the extra jars from mods/ in this zip into that instance's mods folder."
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : `Install ${loaderName} for Minecraft ${profile.runtime.minecraft} and copy every .jar from mods/ into your mods folder.`;

  const readme = (await fs.readFile(path.join(opts.templatesDir, "client-readme.txt"), "utf8"))
    .replaceAll("{{profileName}}", profile.name)
    .replaceAll("{{minecraftVersion}}", profile.runtime.minecraft)
    .replaceAll("{{loaderName}}", loaderName)
    .replaceAll("{{loaderVersion}}", profile.runtime.loaderVersion)
    .replaceAll("{{serverAddress}}", opts.serverAddress ?? "(ask the host)")
    .replaceAll("{{generatedAt}}", new Date().toISOString())
    .replaceAll("{{modpackSection}}", modpackSection)
    .replaceAll(
      "{{modList}}",
      looseJars.length
        ? looseJars.map((m) => `  * ${m.name} ${m.version} (${m.file})`).join("\n")
        : "  (none beyond the modpack)",
    );

  const manifest = {
    generatedBy: "mineserver",
    generatedAt: new Date().toISOString(),
    profile: { id: profile.id, name: profile.name },
    runtime: profile.runtime,
    serverAddress: opts.serverAddress,
    modpack: profile.modpack ?? null,
    mods: looseJars.map((m) => ({
      file: m.file,
      id: m.id,
      version: m.version,
      loader: m.loader,
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
    for (const m of looseJars)
      archive.file(path.join(opts.libraryDir, m.file), { name: `mods/${m.file}` });
    if (mrpackPath && mrpackPresent) archive.file(mrpackPath, { name: path.basename(mrpackPath) });
    archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
    archive.append(readme, { name: "README.txt" });
    void archive.finalize();
  });

  return {
    file,
    sizeBytes: (await fs.stat(dest)).size,
    includedMods: looseJars.map((m) => m.file),
    excludedServerOnly: excluded.map((m) => m.file),
    modpackIncluded: mrpackPresent && profile.modpack ? profile.modpack.file : null,
  };
}
