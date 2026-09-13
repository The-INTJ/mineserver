import yauzl from "yauzl";
import type { ModEnvironment } from "../../shared/types.ts";

export interface FabricModJson {
  id: string;
  version: string;
  name?: string;
  environment?: string;
}

export interface ParsedJar {
  ok: true;
  id: string;
  version: string;
  name: string;
  environment: ModEnvironment;
}

export interface FailedJar {
  ok: false;
  error: string;
}

function normalizeEnvironment(v: unknown): ModEnvironment {
  // Absent means "both sides"; anything else Fabric doesn't recognise is treated the same.
  return v === "client" || v === "server" ? v : "*";
}

/** Read fabric.mod.json out of a jar without extracting anything else. */
export async function readFabricModJson(jarPath: string): Promise<ParsedJar | FailedJar> {
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.openPromise(jarPath, { lazyEntries: true });
  } catch (err) {
    return { ok: false, error: `not a zip: ${(err as Error).message}` };
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: ParsedJar | FailedJar) => {
      if (done) return;
      done = true;
      zip.close();
      resolve(r);
    };
    zip.on("entry", (entry: yauzl.Entry) => {
      if (entry.fileName !== "fabric.mod.json") {
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream)
          return finish({ ok: false, error: `cannot read entry: ${err?.message}` });
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("error", (e) => finish({ ok: false, error: e.message }));
        stream.on("end", () => finish(parseModJson(Buffer.concat(chunks).toString("utf8"))));
      });
    });
    zip.on("end", () => finish({ ok: false, error: "no fabric.mod.json (not a Fabric mod?)" }));
    zip.on("error", (e: Error) => finish({ ok: false, error: e.message }));
    zip.readEntry();
  });
}

export function parseModJson(text: string): ParsedJar | FailedJar {
  try {
    // Some mods ship fabric.mod.json with a UTF-8 BOM, which JSON.parse rejects.
    const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const json = JSON.parse(clean) as Partial<FabricModJson>;
    if (typeof json.id !== "string" || typeof json.version !== "string") {
      return { ok: false, error: "fabric.mod.json missing id/version" };
    }
    return {
      ok: true,
      id: json.id,
      version: json.version,
      name: typeof json.name === "string" ? json.name : json.id,
      environment: normalizeEnvironment(json.environment),
    };
  } catch (err) {
    return { ok: false, error: `fabric.mod.json invalid JSON: ${(err as Error).message}` };
  }
}
