import { promises as fs } from "node:fs";
import path from "node:path";
import type { ModEntry } from "../../shared/types.ts";
import { assertSafeSegment, readJson, writeJsonAtomic } from "../fsx.ts";
import { badRequest, notFound } from "../errors.ts";
import { readFabricModJson } from "./mod-jar.ts";

interface Index {
  mods: Record<string, ModEntry & { mtimeMs: number }>;
}

/**
 * data/mods/library holds every jar exactly once. Profiles reference jars by filename; the
 * server's mods/ dir is rebuilt from hardlinks at launch. library.json caches parsed metadata
 * keyed by filename and is refreshed whenever a jar's size or mtime changes.
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

  jarPath(file: string): string {
    assertSafeSegment(file, "mod filename");
    return path.join(this.dir, file);
  }

  /** Add a jar from bytes (upload) or by copying from a path (import from .minecraft/mods). */
  async add(file: string, source: Buffer | { fromPath: string }): Promise<ModEntry> {
    assertSafeSegment(file, "mod filename");
    if (!file.toLowerCase().endsWith(".jar"))
      throw badRequest("NOT_A_JAR", `${file} is not a .jar`);
    const dest = this.jarPath(file);
    // Unlink first: the old file may be hardlinked into the server mods dir, and overwriting
    // in place would rewrite it under the running server's feet.
    await fs.rm(dest, { force: true });
    if (Buffer.isBuffer(source)) await fs.writeFile(dest, source);
    else await fs.copyFile(source.fromPath, dest);
    const index = await this.refresh(true);
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
      await this.add(name, { fromPath: path.join(sourceDir, name) });
      added.push(name);
    }
    return { added, skipped };
  }

  private async refresh(force = false): Promise<Index> {
    const index = await readJson<Index>(this.indexFile, { mods: {} });
    const names = (await fs.readdir(this.dir).catch(() => [] as string[])).filter((n) =>
      n.toLowerCase().endsWith(".jar"),
    );
    let changed = false;
    const next: Index = { mods: {} };
    for (const file of names) {
      const stat = await fs.stat(path.join(this.dir, file));
      const cached = index.mods[file];
      if (!force && cached && cached.mtimeMs === stat.mtimeMs && cached.sizeBytes === stat.size) {
        next.mods[file] = cached;
        continue;
      }
      changed = true;
      const parsed = await readFabricModJson(path.join(this.dir, file));
      next.mods[file] = {
        file,
        id: parsed.ok ? parsed.id : file.replace(/\.jar$/i, ""),
        version: parsed.ok ? parsed.version : "?",
        name: parsed.ok ? parsed.name : file,
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
