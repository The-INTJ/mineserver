import yauzl from "yauzl";
import type { Loader, ModEnvironment, ModLoaderTag } from "../../shared/types.ts";

export interface ParsedJar {
  ok: true;
  id: string;
  version: string;
  name: string;
  /** Display tag: the single loader, or "multi" when the jar ships manifests for several. */
  loader: ModLoaderTag;
  /** Every loader the jar can load on. */
  loaders: Loader[];
  environment: ModEnvironment;
}

export interface FailedJar {
  ok: false;
  error: string;
}

const MANIFESTS = ["fabric.mod.json", "META-INF/mods.toml", "META-INF/neoforge.mods.toml"] as const;

function normalizeEnvironment(v: unknown): ModEnvironment {
  // Absent means "both sides"; anything else Fabric doesn't recognise is treated the same.
  return v === "client" || v === "server" ? v : "*";
}

/**
 * Read every mod manifest out of a jar without extracting anything else. Fabric jars carry
 * fabric.mod.json; Forge jars META-INF/mods.toml; NeoForge (≥1.20.5) META-INF/neoforge.mods.toml.
 * Multi-loader builds ("QuiFabrge", merged jars, Forge+NeoForge dual jars) ship several, and the
 * jar then loads on all of them, which is why we record the full set, not the first hit.
 */
export async function readModManifest(jarPath: string): Promise<ParsedJar | FailedJar> {
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.openPromise(jarPath, { lazyEntries: true });
  } catch (err) {
    return { ok: false, error: `not a zip: ${(err as Error).message}` };
  }
  const found = new Map<string, string>();
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      zip.close();
      resolve();
    };
    zip.on("entry", (entry: yauzl.Entry) => {
      if (!(MANIFESTS as readonly string[]).includes(entry.fileName)) {
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) {
          zip.readEntry();
          return;
        }
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("error", () => zip.readEntry());
        stream.on("end", () => {
          found.set(entry.fileName, Buffer.concat(chunks).toString("utf8"));
          if (found.size === MANIFESTS.length) finish();
          else zip.readEntry();
        });
      });
    });
    zip.on("end", finish);
    zip.on("error", finish);
    zip.readEntry();
  });
  return combineManifests(found);
}

/** Merge whatever manifests were found into one entry. Exported for tests. */
export function combineManifests(found: Map<string, string>): ParsedJar | FailedJar {
  const parsed: ParsedJar[] = [];
  const errors: string[] = [];
  const push = (p: ParsedJar | FailedJar) => {
    if (p.ok) parsed.push(p);
    else errors.push(p.error);
  };
  const fab = found.get("fabric.mod.json");
  if (fab !== undefined) push(parseFabricModJson(fab));
  const forge = found.get("META-INF/mods.toml");
  if (forge !== undefined) push(parseModsToml(forge, "forge"));
  const neo = found.get("META-INF/neoforge.mods.toml");
  if (neo !== undefined) push(parseModsToml(neo, "neoforge"));
  if (parsed.length === 0) {
    return { ok: false, error: errors[0] ?? "no fabric.mod.json / mods.toml (not a mod jar?)" };
  }
  const loaders = [...new Set(parsed.flatMap((p) => p.loaders))];
  // Prefer the Forge manifest for display metadata: fabric.mod.json in a merged jar is often
  // the more templated of the two.
  const primary = parsed.find((p) => p.loader === "forge") ?? parsed[0];
  return {
    ok: true,
    id: primary.id,
    version:
      primary.version === "?"
        ? (parsed.find((p) => p.version !== "?")?.version ?? "?")
        : primary.version,
    name: primary.name,
    loader: loaders.length > 1 ? "multi" : loaders[0],
    loaders,
    environment: parsed.find((p) => p.loader === "fabric")?.environment ?? "*",
  };
}

export function parseFabricModJson(text: string): ParsedJar | FailedJar {
  try {
    // Some mods ship fabric.mod.json with a UTF-8 BOM, which JSON.parse rejects.
    const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const json = JSON.parse(clean) as {
      id?: unknown;
      version?: unknown;
      name?: unknown;
      environment?: unknown;
    };
    if (typeof json.id !== "string" || typeof json.version !== "string") {
      return { ok: false, error: "fabric.mod.json missing id/version" };
    }
    return {
      ok: true,
      id: json.id,
      version: json.version,
      name: typeof json.name === "string" ? json.name : json.id,
      loader: "fabric",
      loaders: ["fabric"],
      environment: normalizeEnvironment(json.environment),
    };
  } catch (err) {
    return { ok: false, error: `fabric.mod.json invalid JSON: ${(err as Error).message}` };
  }
}

/**
 * Minimal TOML reader for the handful of keys we need from the first [[mods]] table. Not a
 * general TOML parser: values are `key = "string"` or `key = 'string'` or `key = bare`.
 */
export function parseModsToml(text: string, loader: "forge" | "neoforge"): ParsedJar | FailedJar {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/);
  let inMods = false;
  const vals: Record<string, string> = {};
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    if (/^\[\[mods\]\]/.test(line)) {
      if (inMods) break; // second [[mods]] table: stop
      inMods = true;
      continue;
    }
    if (/^\[/.test(line)) {
      if (inMods) break; // any other table after [[mods]] ends it
      continue;
    }
    if (!inMods) continue;
    const m = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    vals[m[1]] = v;
  }
  if (!vals.modId) {
    // "lowcodefml" datapack-mods use the inline-array form: mods = [ { modId = 'x', version = '1', ... } ]
    const inline = /mods\s*=\s*\[\s*\{([^}]*)\}/.exec(text);
    if (inline) {
      for (const m of inline[1].matchAll(
        /([A-Za-z0-9_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,}\s]+))/g,
      )) {
        vals[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
      }
    }
  }
  if (!vals.modId) return { ok: false, error: "mods.toml has no [[mods]] modId" };
  const version = vals.version && !vals.version.startsWith("${") ? vals.version : "?";
  return {
    ok: true,
    id: vals.modId,
    version,
    name: vals.displayName || vals.modId,
    loader,
    loaders: [loader],
    environment: "*",
  };
}
