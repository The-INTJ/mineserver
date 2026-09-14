import { promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { crc32 } from "node:zlib";
import path from "node:path";
import yauzl from "yauzl";
import { assertSafeSegment } from "../fsx.ts";

/** Accept exactly the legacy FTB world prefix, then enforce containment on every component. */
export function restoreEntryPath(raw: string, world: string): string {
  assertSafeSegment(world, "world");
  let name = raw.replace(/\\/g, "/");
  const legacy = `../../worlds/${world}/`;
  if (name.startsWith(legacy)) name = name.slice(legacy.length);
  else if (name.startsWith(`${world}/`)) name = name.slice(world.length + 1);
  else throw new Error(`Unexpected archive root: ${name}`);
  if (!name) return "";
  const parts = name.replace(/\/$/, "").split("/");
  if (
    parts.some(
      (p) =>
        !p ||
        p === "." ||
        p === ".." ||
        /[:\0<>"|?*]/.test(p) ||
        /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
    )
  )
    throw new Error(`Unsafe archive path: ${name}`);
  return parts.join("/");
}

/** Only creates a NEW destination, never merges into an existing world. CRC checks every file. */
export async function verifyRestore(archive: string, world: string, destination: string) {
  const root = path.resolve(destination);
  await fs.mkdir(root); // exclusive: existing directory is always an error
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(
      archive,
      { lazyEntries: true, decodeStrings: false, validateEntrySizes: true },
      (err, opened) => (err ? reject(err) : resolve(opened)),
    ),
  );
  let files = 0;
  let bytes = 0;
  const seen = new Set<string>();
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          const raw = Buffer.isBuffer(entry.fileName)
            ? entry.fileName.toString("utf8")
            : entry.fileName;
          const relative = restoreEntryPath(raw, world);
          if (!relative) {
            zip.readEntry();
            return;
          }
          if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000)
            throw new Error("Archive links are not allowed");
          const target = path.resolve(root, relative);
          if (!target.startsWith(root + path.sep))
            throw new Error("Archive path escapes destination");
          const key = relative.toLowerCase();
          if (seen.has(key)) throw new Error(`Duplicate archive entry: ${relative}`);
          seen.add(key);
          if (raw.endsWith("/") || raw.endsWith("\\")) {
            await fs.mkdir(target, { recursive: true });
            zip.readEntry();
            return;
          }
          if (++files > 100000 || (bytes += entry.uncompressedSize) > 32 * 1024 ** 3)
            throw new Error("Restore size limit exceeded");
          await fs.mkdir(path.dirname(target), { recursive: true });
          const stream = await new Promise<Readable>((res, rej) =>
            zip.openReadStream(entry, (err, s) => (err ? rej(err) : res(s))),
          );
          const file = await fs.open(target, "wx");
          let crc = 0;
          try {
            for await (const chunk of stream) {
              crc = crc32(chunk, crc);
              await file.writeFile(chunk);
            }
          } finally {
            await file.close();
          }
          if (crc !== entry.crc32) throw new Error(`CRC mismatch: ${relative}`);
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
    await fs.access(path.join(root, "level.dat"));
    return { files, bytes, destination: root, verifiedAt: new Date().toISOString() };
  } finally {
    zip.close();
  }
}
