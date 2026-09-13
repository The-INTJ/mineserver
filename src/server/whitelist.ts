import { promises as fs } from "node:fs";
import path from "node:path";
import { badRequest } from "./errors.ts";
import { readJson, writeJsonAtomic } from "./fsx.ts";

export interface WhitelistEntry {
  uuid: string;
  name: string;
}

const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

/** Mojang's compact UUID → the dashed form whitelist.json expects. */
export function dashUuid(compact: string): string {
  const h = compact.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) throw new Error(`bad uuid ${compact}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Resolve a username to its account UUID via Mojang. Returns null when no such account exists
 * (typo, or a Bedrock-only player). Needs internet; online-mode servers do the same lookup.
 */
export async function lookupUuid(name: string): Promise<WhitelistEntry | null> {
  if (!NAME_RE.test(name))
    throw badRequest(
      "BAD_USERNAME",
      `Minecraft usernames are 3-16 letters, digits or underscores: ${name}`,
    );
  const res = await fetch(
    `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`,
  );
  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw new Error(`Mojang API ${res.status} for ${name}`);
  const j = (await res.json()) as { id: string; name: string };
  return { uuid: dashUuid(j.id), name: j.name };
}

/** whitelist.json lives in each runtime dir; the game reads it at boot and on `whitelist reload`. */
export async function readWhitelist(runtimeDir: string): Promise<WhitelistEntry[]> {
  return readJson<WhitelistEntry[]>(path.join(runtimeDir, "whitelist.json"), []);
}

export async function mergeWhitelist(
  runtimeDir: string,
  entries: WhitelistEntry[],
): Promise<WhitelistEntry[]> {
  await fs.mkdir(runtimeDir, { recursive: true });
  const current = await readWhitelist(runtimeDir);
  const byUuid = new Map(current.map((e) => [e.uuid, e]));
  for (const e of entries) byUuid.set(e.uuid, e);
  const next = [...byUuid.values()].sort((a, b) => a.name.localeCompare(b.name));
  await writeJsonAtomic(path.join(runtimeDir, "whitelist.json"), next);
  return next;
}
