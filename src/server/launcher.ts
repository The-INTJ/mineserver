import { spawn } from "node:child_process";
import { openSync, closeSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePaths } from "./config.ts";

// Production launcher returns after readiness. Closing the npm terminal cannot kill the
// daemon or Java. It starts only the manager; the saved profile is started explicitly in UI.
const paths = resolvePaths();
const port = Number(process.env.MINESERVER_PORT ?? 3400);
const url = `http://127.0.0.1:${port}`;
async function healthy(): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const data = (await response.json()) as { setup?: { dataDir?: string } };
    if (data.setup?.dataDir !== paths.data)
      throw new Error("Port is occupied by another data directory");
    return true;
  } catch (err) {
    if (err instanceof Error && err.message.includes("another data")) throw err;
    return false;
  }
}
async function main() {
  if (await healthy()) {
    console.warn(`mineserver is already available at ${url}`);
    return;
  }
  mkdirSync(paths.logs, { recursive: true });
  const log = path.join(paths.logs, `daemon-console-${Date.now()}.log`);
  const fd = openSync(log, "a");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./main.js", import.meta.url))], {
    cwd: paths.root,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  child.on("error", (err) => console.error(err));
  child.unref();
  for (let n = 0; n < 30; n++) {
    if (await healthy()) {
      console.warn(
        `mineserver ready at ${url}. Select Start for the saved profile. You may close this terminal.`,
      );
      return;
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Manager did not become ready. Inspect ${log}`);
}
await main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
