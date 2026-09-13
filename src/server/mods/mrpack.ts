import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import yauzl from "yauzl";
import type { Loader, ModpackRef, Runtime } from "../../shared/types.ts";
import { MODRINTH_USER_AGENT } from "../../shared/constants.ts";
import { badRequest } from "../errors.ts";
import { assertSafeSegment, exists } from "../fsx.ts";
import type { ModLibrary } from "./mod-library.ts";

/**
 * Modrinth modpack format (.mrpack): a zip with modrinth.index.json listing downloadable files
 * (each with client/server env flags) plus overrides/ (and optional server-overrides/,
 * client-overrides/) copied verbatim into the game dir.
 * Spec: https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack
 */

export interface MrpackFile {
  path: string;
  hashes: { sha1?: string; sha512?: string };
  env?: {
    client?: "required" | "optional" | "unsupported";
    server?: "required" | "optional" | "unsupported";
  };
  downloads: string[];
  fileSize?: number;
}

export interface MrpackIndex {
  formatVersion: number;
  game: string;
  versionId: string;
  name: string;
  summary?: string;
  files: MrpackFile[];
  dependencies: Record<string, string>;
}

export interface MrpackPlan {
  runtime: Runtime;
  /** Files the server loads (env.server != unsupported), mods/ only. */
  serverFiles: MrpackFile[];
  /** Files only clients load (server unsupported, client != unsupported), mods/ only. */
  clientFiles: MrpackFile[];
  /** Non-mod paths (resourcepacks, shaderpacks...) the server ignores; listed for the README. */
  nonMods: string[];
}

/** Pure: decide runtime + which files matter to the server. */
export function planMrpack(index: MrpackIndex): MrpackPlan {
  const deps = index.dependencies ?? {};
  const minecraft = deps.minecraft;
  if (!minecraft) throw badRequest("BAD_MRPACK", "modrinth.index.json has no minecraft dependency");
  let loader: Loader | null = null;
  let loaderVersion = "";
  for (const l of ["fabric-loader", "forge", "neoforge", "quilt-loader"] as const) {
    if (deps[l]) {
      loader = l === "fabric-loader" ? "fabric" : l === "quilt-loader" ? "fabric" : l;
      loaderVersion = deps[l];
      break;
    }
  }
  if (!loader) throw badRequest("BAD_MRPACK", `unsupported loader in ${JSON.stringify(deps)}`);
  const serverFiles: MrpackFile[] = [];
  const clientFiles: MrpackFile[] = [];
  const nonMods: string[] = [];
  for (const f of index.files) {
    const isMod = /^mods\/[^/]+\.jar$/i.test(f.path.replace(/\\/g, "/"));
    if (!isMod) {
      nonMods.push(f.path);
      continue;
    }
    const server = f.env?.server ?? "required";
    const client = f.env?.client ?? "required";
    if (server !== "unsupported") serverFiles.push(f);
    else if (client !== "unsupported") clientFiles.push(f);
  }
  return { runtime: { loader, minecraft, loaderVersion }, serverFiles, clientFiles, nonMods };
}

async function readZipEntries(
  zipPath: string,
  want: (name: string) => boolean,
  onEntry: (name: string, data: Buffer) => Promise<void>,
): Promise<void> {
  const zip = await yauzl.openPromise(zipPath, { lazyEntries: true });
  await new Promise<void>((resolve, reject) => {
    zip.on("entry", (entry: yauzl.Entry) => {
      if (/\/$/.test(entry.fileName) || !want(entry.fileName)) {
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) return reject(err ?? new Error("bad entry"));
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("error", reject);
        stream.on("end", () => {
          onEntry(entry.fileName, Buffer.concat(chunks))
            .then(() => zip.readEntry())
            .catch(reject);
        });
      });
    });
    zip.on("end", resolve);
    zip.on("error", reject);
    zip.readEntry();
  });
  zip.close();
}

export async function readMrpackIndex(mrpackPath: string): Promise<MrpackIndex> {
  let index: MrpackIndex | null = null;
  await readZipEntries(
    mrpackPath,
    (n) => n === "modrinth.index.json",
    async (_n, data) => {
      index = JSON.parse(data.toString("utf8")) as MrpackIndex;
    },
  );
  if (!index) throw badRequest("BAD_MRPACK", "no modrinth.index.json in the archive");
  return index;
}

/** Every jar the pack installs on a client: indexed downloads plus overrides/mods. */
export async function listMrpackJarNames(mrpackPath: string): Promise<string[]> {
  const names = new Set<string>();
  const index = await readMrpackIndex(mrpackPath);
  for (const f of index.files) names.add(path.basename(f.path.replace(/\\/g, "/")));
  const zip = await yauzl.openPromise(mrpackPath, { lazyEntries: true });
  await new Promise<void>((resolve, reject) => {
    zip.on("entry", (entry: yauzl.Entry) => {
      const m = /^(?:client-)?overrides\/mods\/([^/]+\.jar)$/i.exec(entry.fileName);
      if (m) names.add(m[1]);
      zip.readEntry();
    });
    zip.on("end", resolve);
    zip.on("error", reject);
    zip.readEntry();
  });
  zip.close();
  return [...names];
}

/**
 * Copy overrides/ and server-overrides/ into the runtime dir. `overrides/mods/*.jar` are
 * returned instead so the caller can put them in the library like any other jar.
 */
export async function applyOverrides(
  mrpackPath: string,
  runtimeDir: string,
): Promise<{ files: number; overrideJars: { name: string; data: Buffer }[] }> {
  let files = 0;
  const overrideJars: { name: string; data: Buffer }[] = [];
  await readZipEntries(
    mrpackPath,
    (n) => n.startsWith("overrides/") || n.startsWith("server-overrides/"),
    async (name, data) => {
      const rel = name.replace(/^(server-)?overrides\//, "");
      if (/^mods\/[^/]+\.jar$/i.test(rel)) {
        overrideJars.push({ name: path.basename(rel), data });
        return;
      }
      if (rel.startsWith("mods/")) return; // stray non-jar under mods/, e.g. .connector files
      const dest = path.join(runtimeDir, rel);
      if (!path.normalize(dest).startsWith(path.normalize(runtimeDir) + path.sep)) return;
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, data);
      files++;
    },
  );
  return { files, overrideJars };
}

export interface DownloadReport {
  (done: number, total: number, current: string): void;
}

/** Download every planned jar into the library (skips ones already present with the right size). */
export async function downloadMrpackFiles(
  files: MrpackFile[],
  library: ModLibrary,
  report: DownloadReport,
  concurrency = 6,
): Promise<string[]> {
  const names: string[] = [];
  let done = 0;
  const queue = [...files];
  const worker = async () => {
    for (;;) {
      const f = queue.shift();
      if (!f) return;
      const name = path.basename(f.path.replace(/\\/g, "/"));
      assertSafeSegment(name, "modpack file");
      names.push(name);
      const have =
        (await library.has(name)) &&
        (f.fileSize === undefined || (await fs.stat(library.jarPath(name))).size === f.fileSize);
      if (!have) {
        const url = f.downloads[0];
        if (!url) throw new Error(`${name}: no download URL`);
        const res = await fetch(url, {
          headers: { "user-agent": MODRINTH_USER_AGENT },
          redirect: "follow",
        });
        if (!res.ok) throw new Error(`${name}: ${res.status} from ${url}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (f.hashes?.sha1) {
          const sha1 = createHash("sha1").update(buf).digest("hex");
          if (sha1 !== f.hashes.sha1) throw new Error(`${name}: sha1 mismatch`);
        }
        await library.add(name, buf, { refresh: false });
      }
      done++;
      report(done, files.length, name);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return names.sort();
}

/** Resolve a Modrinth project slug/URL (or a direct .mrpack URL) to the newest .mrpack download. */
export async function resolveModpackSource(
  source: string,
): Promise<{ url: string; filename: string; name: string; version: string }> {
  const s = source.trim();
  if (/\.mrpack(\?|$)/i.test(s)) {
    const filename = decodeURIComponent(new URL(s).pathname.split("/").pop() || "pack.mrpack");
    return { url: s, filename, name: filename.replace(/\.mrpack$/i, ""), version: "?" };
  }
  const m = /modrinth\.com\/(?:modpack|project)\/([A-Za-z0-9_-]+)/.exec(s);
  const slug = m ? m[1] : s;
  if (!/^[A-Za-z0-9_-]+$/.test(slug))
    throw badRequest("BAD_SOURCE", "Give a Modrinth modpack URL/slug or a direct .mrpack URL");
  const headers = { "user-agent": MODRINTH_USER_AGENT };
  const proj = await fetch(`https://api.modrinth.com/v2/project/${slug}`, { headers });
  if (!proj.ok)
    throw badRequest("MODPACK_NOT_FOUND", `Modrinth has no project "${slug}" (${proj.status})`);
  const p = (await proj.json()) as { title: string; project_type: string };
  if (p.project_type !== "modpack")
    throw badRequest("NOT_A_MODPACK", `"${slug}" is a ${p.project_type}, not a modpack`);
  const vers = (await (
    await fetch(`https://api.modrinth.com/v2/project/${slug}/version`, { headers })
  ).json()) as {
    version_number: string;
    version_type: string;
    date_published: string;
    files: { url: string; filename: string; primary: boolean }[];
  }[];
  const v = vers.find((x) => x.version_type === "release") ?? vers[0];
  if (!v) throw badRequest("MODPACK_NO_VERSIONS", `"${slug}" has no versions`);
  const file =
    v.files.find((f) => f.primary && f.filename.endsWith(".mrpack")) ??
    v.files.find((f) => f.filename.endsWith(".mrpack"));
  if (!file)
    throw badRequest("MODPACK_NO_MRPACK", `"${slug}" ${v.version_number} has no .mrpack file`);
  return { url: file.url, filename: file.filename, name: p.title, version: v.version_number };
}

export async function downloadMrpack(
  url: string,
  dest: string,
  report: (mb: number) => void,
): Promise<void> {
  if (await exists(dest)) return;
  const res = await fetch(url, {
    headers: { "user-agent": MODRINTH_USER_AGENT },
    redirect: "follow",
  });
  if (!res.ok || !res.body) throw new Error(`${url}: ${res.status}`);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
    bytes += chunk.length;
    if (chunks.length % 64 === 0) report(bytes / 1e6);
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(`${dest}.part`, Buffer.concat(chunks));
  await fs.rename(`${dest}.part`, dest);
}

export function modpackRef(
  name: string,
  version: string,
  source: string,
  file: string,
): ModpackRef {
  return { name, version, source, file };
}
