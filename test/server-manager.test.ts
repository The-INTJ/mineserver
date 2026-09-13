import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { createContext, type AppContext } from "../src/server/context.ts";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-java.mjs");

const until = async (cond: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
};

let dataDir: string;
let ctx: AppContext;

async function makeCtx(extraArgs: string[] = []) {
  ctx = await createContext({
    dataDir,
    javaPath: process.execPath,
    spawnOverride: { javaPath: process.execPath, args: [FAKE, ...extraArgs] },
  });
  return ctx;
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mineserver-test-"));
});
afterEach(async () => {
  await ctx?.server.stop();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("ServerManager with a fake java", () => {
  it("goes starting -> running on Done, tracks players, and stops cleanly", async () => {
    await makeCtx();
    const s = await ctx.server.start();
    expect(s.status).toBe("starting");
    expect(s.activeProfileId).toBe("default");
    await until(() => ctx.server.getState().status === "running");

    ctx.server.send("join");
    await until(() => ctx.server.getState().players.includes("Steve"));
    ctx.server.send("leave");
    await until(() => ctx.server.getState().players.length === 0);

    const stopped = await ctx.server.stop();
    expect(stopped.status).toBe("stopped");
    expect(stopped.lastExitCode).toBe(0);

    // A log file was written for the launch.
    const logs = await fs.readdir(path.join(dataDir, "logs"));
    expect(logs.some((n) => n.startsWith("server-"))).toBe(true);
    // The world junction exists and server.properties was materialized with forced keys.
    const props = await fs.readFile(path.join(dataDir, "server", "server.properties"), "utf8");
    expect(props).toMatch(/^level-name=world$/m);
    expect(props).toMatch(/^white-list=true$/m);
    const st = await fs.lstat(path.join(dataDir, "server", "world"));
    expect(st.isSymbolicLink()).toBe(true);
  });

  it("refuses a double start and reports crashes", async () => {
    await makeCtx(["--crash"]);
    await ctx.server.start();
    await until(() => ctx.server.getState().status === "crashed");
    expect(ctx.server.getState().lastExitCode).toBe(1);
    expect(ctx.server.getState().lastStopReason).toMatch(/unexpected exception/);
  });

  it("returns 409 from the API while running", async () => {
    await makeCtx();
    const app = createApp(ctx);
    const first = await app.request("/api/server/start", { method: "POST" });
    expect(first.status).toBe(200);
    await until(() => ctx.server.getState().status === "running");
    const second = await app.request("/api/server/start", { method: "POST" });
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe("SERVER_RUNNING");
    const activate = await app.request("/api/profiles/default/activate", { method: "POST" });
    expect(activate.status).toBe(409);
  });

  it("materializes enabled mods as hardlinks from the library", async () => {
    await makeCtx();
    const lib = path.join(dataDir, "mods", "library");
    await fs.writeFile(path.join(lib, "a.jar"), "PK-fake");
    await fs.writeFile(path.join(dataDir, "server", "mods", "stale.jar"), "old");
    await ctx.profiles.update("default", { enabledMods: ["a.jar", "missing.jar"] });
    await ctx.server.start();
    const names = (await fs.readdir(path.join(dataDir, "server", "mods"))).sort();
    expect(names).toEqual(["a.jar"]);
    expect(ctx.logs.tail(50).some((l) => l.text.includes("missing.jar"))).toBe(true);
  });
});
