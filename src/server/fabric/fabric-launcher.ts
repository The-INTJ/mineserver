import { promises as fs } from "node:fs";
import path from "node:path";
import { FABRIC_LAUNCHER_FILENAME, FABRIC_LAUNCHER_URL } from "../../shared/constants.ts";
import { exists } from "../fsx.ts";

export function launcherJarPath(serverDir: string): string {
  return path.join(serverDir, FABRIC_LAUNCHER_FILENAME);
}

export async function launcherPresent(serverDir: string): Promise<boolean> {
  const p = launcherJarPath(serverDir);
  if (!(await exists(p))) return false;
  return (await fs.stat(p)).size > 0;
}

/**
 * The Fabric "server launcher" is a small bootstrap jar; on first run it downloads the vanilla
 * server for the pinned Minecraft version into the server dir. We never redistribute either.
 */
export async function downloadLauncher(
  serverDir: string,
): Promise<{ file: string; bytes: number }> {
  const res = await fetch(FABRIC_LAUNCHER_URL);
  if (!res.ok) throw new Error(`Fabric meta returned ${res.status} for ${FABRIC_LAUNCHER_URL}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 10_000) throw new Error(`Launcher download too small (${buf.length} bytes)`);
  const file = launcherJarPath(serverDir);
  await fs.mkdir(serverDir, { recursive: true });
  await fs.writeFile(`${file}.part`, buf);
  await fs.rename(`${file}.part`, file);
  return { file, bytes: buf.length };
}
