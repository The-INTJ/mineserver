import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Mojang's server refuses to start until eula.txt says eula=true. We only write it after the
 * user explicitly accepts in the UI; the acceptance is also mirrored into data/state.json.
 */
export async function eulaAccepted(serverDir: string): Promise<boolean> {
  try {
    const text = await fs.readFile(path.join(serverDir, "eula.txt"), "utf8");
    return /^\s*eula\s*=\s*true\s*$/im.test(text);
  } catch {
    return false;
  }
}

export async function writeEula(serverDir: string, accepted: boolean): Promise<void> {
  await fs.mkdir(serverDir, { recursive: true });
  const body = [
    "# Accepted via mineserver UI. By changing this to true you agree to",
    "# https://aka.ms/MinecraftEULA",
    `# ${new Date().toISOString()}`,
    `eula=${accepted ? "true" : "false"}`,
    "",
  ].join("\n");
  await fs.writeFile(path.join(serverDir, "eula.txt"), body, "utf8");
}
