import { createWriteStream } from "node:fs";
import { ZipArchive } from "archiver";

/** Build a tiny jar (zip) from a map of entry name to text content. Test helper only. */
export async function makeJar(file: string, entries: Record<string, string>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(file);
    const archive = new ZipArchive({ zlib: { level: 1 } });
    out.on("close", resolve);
    out.on("error", reject);
    archive.on("error", reject);
    archive.pipe(out);
    for (const [name, text] of Object.entries(entries)) archive.append(text, { name });
    void archive.finalize();
  });
}
