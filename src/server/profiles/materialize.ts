import { promises as fs } from "node:fs";
import path from "node:path";
import { linkOrCopy } from "../fsx.ts";

export interface ModPlan {
  /** Jars to remove from the server mods dir (every existing jar; we rebuild from scratch). */
  unlink: string[];
  /** [libraryPath, serverModsPath] pairs to link. */
  link: [string, string][];
  /** Enabled mods that no longer exist in the library; reported, not fatal. */
  missing: string[];
}

/**
 * Pure planning step: the server's mods/ dir is always rebuilt from the enabled set. Rebuilding
 * (rather than diffing) is what makes a replaced library jar take effect: hardlinks are cheap and
 * a stale link to old content is the bug we're avoiding. Non-jar files (configs) are untouched.
 */
export function planMods(
  enabledFiles: string[],
  libraryFiles: Set<string>,
  libraryDir: string,
  serverModsDir: string,
  existingServerJars: string[],
): ModPlan {
  const plan: ModPlan = { unlink: [], link: [], missing: [] };
  for (const jar of existingServerJars) {
    if (jar.toLowerCase().endsWith(".jar")) plan.unlink.push(path.join(serverModsDir, jar));
  }
  for (const file of enabledFiles) {
    if (!libraryFiles.has(file)) {
      plan.missing.push(file);
      continue;
    }
    plan.link.push([path.join(libraryDir, file), path.join(serverModsDir, file)]);
  }
  return plan;
}

export async function applyModPlan(plan: ModPlan): Promise<{ linked: number; copied: number }> {
  for (const p of plan.unlink) await fs.rm(p, { force: true });
  let linked = 0;
  let copied = 0;
  for (const [from, to] of plan.link) {
    await fs.mkdir(path.dirname(to), { recursive: true });
    if ((await linkOrCopy(from, to)) === "link") linked++;
    else copied++;
  }
  return { linked, copied };
}
