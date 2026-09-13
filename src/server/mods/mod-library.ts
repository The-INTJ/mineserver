import { promises as fs } from "node:fs";
import path from "node:path";
import type { ModEntry } from "../../shared/types.ts";
import { assertSafeSegment, readJson, writeJsonAtomic } from "../fsx.ts";
import { badRequest, notFound } from "../errors.ts";
import { readModManifest } from "./mod-jar.ts";

const INDEX_VERSION = 3;

interface Index {
  version?: number;
  mods: Record<string, ModEntry & { mtimeMs: number }>;
}

/**
 * data/mods/library holds every jar exactly once, whatever loader or Minecraft version it targets.
 * Profiles reference jars by filename; each runtime's mods/ dir is rebuilt from hardlinks at
 * launch. library.json caches parsed metadata keyed by filename and is refreshed whenever a jar's
 * size or mtime changes.
 */
export class ModLibrary {
  constructor(
    private readonly dir: string,
    private readonly indexFile: string,
  ) {}

  async list(): Promise<ModEntry[]> {
    const index = await this.refresh();
    return Object.values(index.mods)
      .map(({ mtimeMs: _m, ...entry }) => entry)
      .sort((a, b) => a.file.localeCompare(b.file));
  }

  async get(file: string): Promise<ModEntry> {
    const entry = (await this.refresh()).mods[file];
    if (!entry) throw notFound("MOD_NOT_FOUND", `No mod ${file} in library`);
    const { mtimeMs: _m, ...rest } = entry;
    return rest;
  }

  async has(file: string): Promise<boolean> {
    assertSafeSegment(file, "mod filename");
    try {
      return (await fs.stat(path.join(this.dir, file))).isFile();
    } catch {
      return false;
    }
  }

  jarPath(file: string): string {
    assertSafeSegment(file, "mod filename");
    return path.join(this.dir, file);
  }

  /** Add a jar from bytes (upload/download) or by copying from a path (import from .minecraft/mods). */
  async add(
    file: string,
    source: Buffer | { fromPath: string },
    opts: { refresh?: boolean } = {},
  ): Promise<ModEntry> {
    assertSafeSegment(file, "mod filename");
    if (!file.toLowerCase().endsWith(".jar"))
      throw badRequest("NOT_A_JAR", `${file} is not a .jar`);
    const dest = this.jarPath(file);
    // Unlink first: the old file may be hardlinked into a server mods dir, and overwriting in
    // place would rewrite it under the running server's feet.
    await fs.rm(dest, { force: true });
    if (Buffer.isBuffer(source)) await fs.writeFile(dest, source);
    else await fs.copyFile(source.fromPath, dest);
    if (opts.refresh === false) {
      const st = await fs.stat(dest);
      return {
        file,
        id: file,
        version: "?",
        name: file,
        loader: "unknown",
        loaders: [],
        environment: "*",
        sizeBytes: st.size,
        addedAt: new Date().toISOString(),
      };
    }
    const index = await this.refresh();
    const { mtimeMs: _m, ...rest } = index.mods[file];
    return rest;
  }

  async remove(file: string): Promise<void> {
    await fs.rm(this.jarPath(file), { force: true });
    await this.refresh(true);
  }

  /** Bulk import every jar from a directory (typically %APPDATA%\.minecraft\mods). */
  async importDir(sourceDir: string): Promise<{ added: string[]; skipped: string[] }> {
    const added: string[] = [];
    const skipped: string[] = [];
    const names = await fs.readdir(sourceDir).catch(() => [] as string[]);
    const existing = new Set(Object.keys((await this.refresh()).mods));
    for (const name of names) {
      if (!name.toLowerCase().endsWith(".jar")) continue;
      if (existing.has(name)) {
        skipped.push(name);
        continue;
      }
      await this.add(name, { fromPath: path.join(sourceDir, name) }, { refresh: false });
      added.push(name);
    }
    await this.refresh();
    return { added, skipped };
  }

  /** Re-scan the directory; parses only jars whose size/mtime changed (or all when forced). */
  async refresh(force = false): Promise<Index> {
    const index = await readJson<Index>(this.indexFile, { mods: {} });
    // A schema bump (new fields) invalidates every cached entry.
    if (index.version !== INDEX_VERSION) force = true;
    const names = (await fs.readdir(this.dir).catch(() => [] as string[])).filter((n) =>
      n.toLowerCase().endsWith(".jar"),
    );
    let changed = false;
    const next: Index = { version: INDEX_VERSION, mods: {} };
    for (const file of names) {
      const stat = await fs.stat(path.join(this.dir, file));
      const cached = index.mods[file];
      if (
        !force &&
        cached &&
        cached.loader &&
        cached.mtimeMs === stat.mtimeMs &&
        cached.sizeBytes === stat.size
      ) {
        next.mods[file] = cached;
        continue;
      }
      changed = true;
      const parsed = await readModManifest(path.join(this.dir, file));
      next.mods[file] = {
        file,
        id: parsed.ok ? parsed.id : file.replace(/\.jar$/i, ""),
        version: parsed.ok ? parsed.version : "?",
        name: parsed.ok ? parsed.name : file,
        loader: parsed.ok ? parsed.loader : "unknown",
        loaders: parsed.ok ? parsed.loaders : [],
        environment: parsed.ok ? parsed.environment : "*",
        sizeBytes: stat.size,
        addedAt: cached?.addedAt ?? new Date().toISOString(),
        mtimeMs: stat.mtimeMs,
        ...(parsed.ok ? {} : { parseError: parsed.error }),
      };
    }
    if (Object.keys(index.mods).length !== names.length) changed = true;
    if (changed) await writeJsonAtomic(this.indexFile, next);
    return next;
  }
}
