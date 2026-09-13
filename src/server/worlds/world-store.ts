import { promises as fs } from "node:fs";
import path from "node:path";
import type { ImportCandidate, WorldInfo } from "../../shared/types.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { assertSafeSegment, dirSize, exists, slugify } from "../fsx.ts";

/**
 * Worlds live in data/worlds/<name>. The server only ever sees data/server/world, which is a
 * directory junction to the active one. Junctions (unlike symlinks) need no Developer Mode or
 * admin on Windows, and the alternative of a `../` level-name is undocumented.
 */
export class WorldStore {
  constructor(
    private readonly worldsDir: string,
    private readonly serverWorldLink: string,
    private readonly minecraftSaves: string,
  ) {}

  worldPath(name: string): string {
    assertSafeSegment(name, "world name");
    return path.join(this.worldsDir, name);
  }

  async list(): Promise<WorldInfo[]> {
    const entries = await fs.readdir(this.worldsDir, { withFileTypes: true }).catch(() => []);
    const out: WorldInfo[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(this.worldsDir, e.name);
      out.push({
        name: e.name,
        sizeBytes: await dirSize(p),
        hasLevelDat: await exists(path.join(p, "level.dat")),
        modifiedAt: (await fs.stat(p)).mtime.toISOString(),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async ensure(name: string): Promise<string> {
    const p = this.worldPath(name);
    await fs.mkdir(p, { recursive: true });
    return p;
  }

  async importCandidates(): Promise<ImportCandidate[]> {
    const entries = await fs.readdir(this.minecraftSaves, { withFileTypes: true }).catch(() => []);
    const out: ImportCandidate[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(this.minecraftSaves, e.name);
      if (!(await exists(path.join(p, "level.dat")))) continue;
      out.push({
        name: e.name,
        sizeBytes: await dirSize(p),
        modifiedAt: (await fs.stat(p)).mtime.toISOString(),
      });
    }
    return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  /** Copy (never link) a single-player save in. The client keeps its copy untouched. */
  async importFromSaves(sourceName: string, targetName?: string): Promise<WorldInfo> {
    assertSafeSegment(sourceName, "save name");
    const src = path.join(this.minecraftSaves, sourceName);
    if (!(await exists(path.join(src, "level.dat")))) {
      throw notFound("SAVE_NOT_FOUND", `No single-player save named ${sourceName}`);
    }
    const name = slugify(targetName?.trim() || sourceName);
    const dest = this.worldPath(name);
    if (await exists(dest)) throw conflict("WORLD_EXISTS", `World ${name} already exists`);
    await fs.cp(src, dest, {
      recursive: true,
      // session.lock is the client's; copying it can make the server think the world is open.
      filter: (p) => path.basename(p) !== "session.lock",
    });
    return {
      name,
      sizeBytes: await dirSize(dest),
      hasLevelDat: true,
      modifiedAt: new Date().toISOString(),
    };
  }

  async remove(name: string): Promise<void> {
    const p = this.worldPath(name);
    if (!(await exists(p))) throw notFound("WORLD_NOT_FOUND", `No world ${name}`);
    if ((await this.activeWorld()) === name) {
      throw conflict("WORLD_ACTIVE", `World ${name} is linked as the active world`);
    }
    await fs.rm(p, { recursive: true, force: true });
  }

  /** Which world does data/server/world currently point at? */
  async activeWorld(): Promise<string | null> {
    try {
      const st = await fs.lstat(this.serverWorldLink);
      if (!st.isSymbolicLink()) return null;
      const target = await fs.readlink(this.serverWorldLink);
      return path.basename(target.replace(/[\\/]+$/, ""));
    } catch {
      return null;
    }
  }

  /** Point data/server/world at data/worlds/<name>, replacing any previous junction. */
  async link(name: string): Promise<void> {
    const target = await this.ensure(name);
    const st = await fs.lstat(this.serverWorldLink).catch(() => null);
    if (st) {
      if (st.isSymbolicLink()) {
        await fs.rm(this.serverWorldLink, { recursive: false, force: true });
      } else {
        // A real directory here means something wrote a world straight into data/server.
        // Refuse rather than delete: it may be the only copy.
        throw badRequest(
          "WORLD_LINK_BLOCKED",
          `${this.serverWorldLink} is a real directory, not a junction. Move it into data/worlds first.`,
        );
      }
    }
    // "junction" is ignored on non-Windows and becomes a normal directory symlink.
    await fs.symlink(target, this.serverWorldLink, "junction");
  }
}
