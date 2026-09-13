import { promises as fs } from "node:fs";
import path from "node:path";

/** Write JSON via temp file + rename so a crash mid-write never leaves a torn file. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(tmp, file);
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await fs.stat(p)).size;
  }
  return total;
}

/**
 * Hardlink, falling back to copy when the link crosses volumes (EXDEV: data/ is on E:,
 * .minecraft is on C:). Never overwrite in place: a hardlinked file shares content with
 * every other link, so replacing it would silently mutate the library copy too.
 */
export async function linkOrCopy(from: string, to: string): Promise<"link" | "copy"> {
  await fs.rm(to, { force: true });
  try {
    await fs.link(from, to);
    return "link";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EXDEV" && code !== "EPERM") throw err;
    await fs.copyFile(from, to);
    return "copy";
  }
}

/** A safe folder/file slug: lowercase, ascii, dashes. "BehBeh & me CONQUER" becomes "behbeh-and-me-conquer". */
export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "unnamed";
}

/** Reject anything that could escape a directory when used as a single path segment. */
export function assertSafeSegment(name: string, what: string): void {
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) {
    throw new Error(`Invalid ${what}: ${JSON.stringify(name)}`);
  }
}
