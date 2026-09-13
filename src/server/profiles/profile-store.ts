import { promises as fs } from "node:fs";
import path from "node:path";
import type { Profile, ProfileInput, Runtime } from "../../shared/types.ts";
import { DEFAULT_MAX_MEMORY_GB, DEFAULT_RUNTIME } from "../../shared/constants.ts";
import { badRequest, notFound } from "../errors.ts";
import { exists, readJson, slugify, writeJsonAtomic } from "../fsx.ts";

export const DEFAULT_PROFILE_ID = "default";

const LOADERS = new Set(["fabric", "forge", "neoforge"]);

export function validateRuntime(rt: unknown): Runtime {
  const r = rt as Partial<Runtime> | undefined;
  if (!r || !LOADERS.has(String(r.loader)) || !r.minecraft?.trim() || !r.loaderVersion?.trim()) {
    throw badRequest(
      "BAD_RUNTIME",
      "runtime needs loader (fabric|forge|neoforge), minecraft and loaderVersion",
    );
  }
  if (
    !/^[0-9][0-9A-Za-z.\-+_]*$/.test(r.minecraft) ||
    !/^[0-9][0-9A-Za-z.\-+_]*$/.test(r.loaderVersion)
  ) {
    throw badRequest("BAD_RUNTIME", "runtime versions must look like version numbers");
  }
  return {
    loader: r.loader as Runtime["loader"],
    minecraft: r.minecraft.trim(),
    loaderVersion: r.loaderVersion.trim(),
  };
}

/** One JSON file per profile under data/profiles. Ids are slugs and never change. */
export class ProfileStore {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  /** Fill in fields added after a profile was written (v0.1 had no runtime/clientMods). */
  private upgrade(p: Profile): Profile {
    return {
      ...p,
      runtime: p.runtime ?? DEFAULT_RUNTIME,
      clientMods: p.clientMods ?? [],
      enabledMods: p.enabledMods ?? [],
      properties: p.properties ?? {},
      jvm: p.jvm ?? { maxMemoryGb: DEFAULT_MAX_MEMORY_GB, extraArgs: [] },
    };
  }

  async list(): Promise<Profile[]> {
    const names = (await fs.readdir(this.dir).catch(() => [] as string[])).filter((n) =>
      n.endsWith(".json"),
    );
    const out: Profile[] = [];
    for (const n of names) {
      const p = await readJson<Profile | null>(path.join(this.dir, n), null);
      if (p) out.push(this.upgrade(p));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<Profile> {
    const p = await readJson<Profile | null>(this.file(id), null);
    if (!p) throw notFound("PROFILE_NOT_FOUND", `No profile ${id}`);
    return this.upgrade(p);
  }

  async has(id: string): Promise<boolean> {
    return exists(this.file(id));
  }

  async create(input: ProfileInput): Promise<Profile> {
    if (!input.name?.trim()) throw badRequest("PROFILE_NAME_REQUIRED", "Profile name is required");
    let id = slugify(input.name);
    for (let n = 2; await this.has(id); n++) id = `${slugify(input.name)}-${n}`;
    const now = new Date().toISOString();
    const profile: Profile = {
      id,
      name: input.name.trim(),
      runtime: input.runtime ? validateRuntime(input.runtime) : DEFAULT_RUNTIME,
      world: input.world ?? id,
      enabledMods: input.enabledMods ?? [],
      clientMods: input.clientMods ?? [],
      properties: input.properties ?? {},
      jvm: input.jvm ?? { maxMemoryGb: DEFAULT_MAX_MEMORY_GB, extraArgs: [] },
      ...(input.modpack ? { modpack: input.modpack } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonAtomic(this.file(id), profile);
    return profile;
  }

  async update(id: string, patch: Partial<Omit<Profile, "id" | "createdAt">>): Promise<Profile> {
    const current = await this.get(id);
    const next: Profile = {
      ...current,
      ...patch,
      ...(patch.runtime ? { runtime: validateRuntime(patch.runtime) } : {}),
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(this.file(id), next);
    return next;
  }

  async setModEnabled(
    id: string,
    file: string,
    enabled: boolean,
    side: "server" | "client" = "server",
  ): Promise<Profile> {
    const p = await this.get(id);
    const key = side === "server" ? "enabledMods" : "clientMods";
    const set = new Set(p[key]);
    if (enabled) set.add(file);
    else set.delete(file);
    return this.update(id, { [key]: [...set].sort() });
  }

  async remove(id: string): Promise<void> {
    await this.get(id);
    await fs.rm(this.file(id), { force: true });
  }

  /** First-run convenience: a vanilla-ish profile so "Start" works before any setup. */
  async ensureDefault(): Promise<Profile> {
    if (await this.has(DEFAULT_PROFILE_ID)) return this.get(DEFAULT_PROFILE_ID);
    const now = new Date().toISOString();
    const profile: Profile = {
      id: DEFAULT_PROFILE_ID,
      name: "Default",
      runtime: DEFAULT_RUNTIME,
      world: "default",
      enabledMods: [],
      clientMods: [],
      properties: {},
      jvm: { maxMemoryGb: DEFAULT_MAX_MEMORY_GB, extraArgs: [] },
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonAtomic(this.file(DEFAULT_PROFILE_ID), profile);
    return profile;
  }
}
