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
    stopTimeoutMs: 500,
    recoveryDelayMs: 50,
    spawnOverride: { javaPath: process.execPath, args: [FAKE, ...extraArgs] },
  });
  return ctx;
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mineserver-test-"));
});
afterEach(async () => {
  await ctx?.server.dispose();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
});

const runtimeDir = () => path.join(dataDir, "servers", "fabric-26.2");

describe("ServerManager with a fake java", () => {
  it("serializes simultaneous start requests before preflight", async () => {
    await makeCtx();
    const results = await Promise.allSettled([ctx.server.start(), ctx.server.start()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    await until(() => ctx.server.getState().status === "running");
  });

  it("records saves and normal stop even after a misleading FATAL, surviving restart", async () => {
    await makeCtx(["--fatal-warning"]);
    await ctx.server.start();
    await until(() => ctx.server.getState().status === "running");
    expect(ctx.server.getState().lastStopReason).toBeNull();
    ctx.server.send("spoof-save");
    await until(() =>
      ctx.logs.tail(20).some((line) => line.text.includes("<Steve> ThreadedAnvilChunkStorage")),
    );
    expect(ctx.server.reliability().run?.saveConfirmedAt).toBeNull();
    expect((await ctx.server.save()).savedAt).toBeTruthy();
    await ctx.server.stop();
    expect(ctx.server.getState().lastStopReason).toBe("stopped by request");
    const run = ctx.server.reliability().run!;
    expect(run.saveConfirmedAt).toBeTruthy();
    const capture = await fs.readFile(path.join(dataDir, "logs", run.logFile!), "utf8");
    expect(capture).toContain("sending graceful stop");
    expect(capture).toContain("All dimensions are saved");
    expect(capture).toContain("server process exited");
    await ctx.server.dispose();
    await makeCtx();
    expect(ctx.server.reliability().run?.id).toBe(run.id);
    expect(ctx.server.getState().lastStopReason).toBe("stopped by request");
  });

  it("guardian saves after the manager disconnects", async () => {
    await makeCtx();
    await ctx.server.start();
    await until(() => ctx.server.getState().status === "running");
    const receipt = ctx.server.incidents.receiptFile(ctx.server.reliability().run!.id);
    ctx.server.killSync();
    await until(() => !ctx.server.isActive);
    const result = JSON.parse(await fs.readFile(receipt, "utf8"));
    expect(result.code).toBe(0);
    expect(result.saveConfirmedAt).toBeTruthy();
    expect(result.reason).toContain("manager connection lost");
    expect(result.forced).toBe(false);
  });

  it("guardian excludes a second manager before runtime mutation", async () => {
    await makeCtx();
    await ctx.server.start();
    await until(() => ctx.server.getState().status === "running");
    const before = await fs.readFile(path.join(runtimeDir(), "server.properties"), "utf8");
    const other = await createContext({
      dataDir,
      spawnOverride: { javaPath: process.execPath, args: [FAKE] },
    });
    await expect(other.server.start()).rejects.toThrow(/Runtime already owned|Guardian/);
    expect(await fs.readFile(path.join(runtimeDir(), "server.properties"), "utf8")).toBe(before);
    expect(ctx.server.getState().status).toBe("running");
    await other.server.dispose();
  });

  it("bounds shutdown when a child ignores stop and marks the save uncertain", async () => {
    await makeCtx(["--ignore-stop"]);
    await ctx.server.start();
    await until(() => ctx.server.getState().status === "running");
    const result = await ctx.server.stop();
    expect(result.status).toBe("crashed");
    expect(result.lastStopReason).toContain("forced stop");
    expect(ctx.server.reliability().run?.forced).toBe(true);
  });

  it("continues when the log directory becomes unwritable", async () => {
    await makeCtx();
    await fs.rmdir(path.join(dataDir, "logs"));
    await fs.writeFile(path.join(dataDir, "logs"), "not a directory");
    await ctx.server.start();
    await until(() => ctx.server.getState().status === "running");
    expect(ctx.server.reliability().loggingError).toContain("unavailable");
    await ctx.server.stop();
    expect(ctx.server.reliability().run?.saveConfirmedAt).toBeTruthy();
  });

  it("retries a runtime crash but cancels recovery on Stop", async () => {
    await fs.writeFile(
      path.join(dataDir, "reliability.json"),
      JSON.stringify({ autoRestart: true }),
    );
    await makeCtx();
    await ctx.server.start();
    await until(() => ctx.server.getState().status === "running");
    const first = ctx.server.reliability().run!.id;
    ctx.server.send("crash-now");
    await until(
      () =>
        ctx.server.getState().status === "running" && ctx.server.reliability().run!.id !== first,
    );
    expect(ctx.server.reliability().recovery.attempts).toBe(1);
    await ctx.server.stop();
    expect(ctx.server.reliability().recovery.nextAttemptAt).toBeNull();
    expect(ctx.server.getState().status).toBe("stopped");
  });

  it("rejects a cross-site browser request to the management API", async () => {
    await makeCtx();
    const response = await createApp(ctx).request("/api/server/start", {
      method: "POST",
      headers: { Origin: "https://example.com" },
    });
    expect(response.status).toBe(403);
    expect(ctx.server.getState().status).toBe("stopped");
  });
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
    // The runtime dir got the world junction and a server.properties with forced keys.
    const props = await fs.readFile(path.join(runtimeDir(), "server.properties"), "utf8");
    expect(props).toMatch(/^level-name=world$/m);
    expect(props).toMatch(/^white-list=true$/m);
    const st = await fs.lstat(path.join(runtimeDir(), "world"));
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

  it("materializes enabled mods as hardlinks and skips jars for another loader", async () => {
    await makeCtx();
    const lib = path.join(dataDir, "mods", "library");
    await fs.writeFile(path.join(lib, "a.jar"), "PK-fake");
    await fs.writeFile(path.join(lib, "forge-only.jar"), "PK-fake");
    // Pretend the index already knows forge-only.jar is a Forge jar (it isn't a real zip).
    await ctx.library.refresh();
    const indexFile = path.join(dataDir, "mods", "library.json");
    const index = JSON.parse(await fs.readFile(indexFile, "utf8"));
    index.mods["forge-only.jar"].loader = "forge";
    index.mods["forge-only.jar"].loaders = ["forge"];
    await fs.writeFile(indexFile, JSON.stringify(index));
    await fs.mkdir(path.join(runtimeDir(), "mods"), { recursive: true });
    await fs.writeFile(path.join(runtimeDir(), "mods", "stale.jar"), "old");
    await ctx.profiles.update("default", {
      enabledMods: ["a.jar", "forge-only.jar"],
    });
    await ctx.server.start();
    const names = (await fs.readdir(path.join(runtimeDir(), "mods"))).sort();
    expect(names).toEqual(["a.jar"]);
    const notes = ctx.logs.tail(50).map((l) => l.text);
    expect(notes.some((t) => t.includes("forge-only.jar") && t.includes("skipping"))).toBe(true);
  });

  it("refuses missing enabled mods before changing the runtime mods or opening Java", async () => {
    await makeCtx();
    await fs.mkdir(path.join(runtimeDir(), "mods"), { recursive: true });
    await fs.writeFile(path.join(runtimeDir(), "mods", "keep.jar"), "untouched");
    await ctx.profiles.update("default", { enabledMods: ["missing.jar"] });
    await expect(ctx.server.start()).rejects.toThrow("missing enabled mods");
    expect(await fs.readFile(path.join(runtimeDir(), "mods", "keep.jar"), "utf8")).toBe(
      "untouched",
    );
    expect(ctx.server.getState().pid).toBeNull();
    expect(ctx.server.isActive).toBe(false);
  });

  it("upgrades v0.1 profiles and migrates data/server to data/servers/fabric-26.2", async () => {
    await fs.mkdir(path.join(dataDir, "server", "mods"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "server", "eula.txt"), "eula=true\n");
    await fs.mkdir(path.join(dataDir, "profiles"), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "profiles", "old.json"),
      JSON.stringify({
        id: "old",
        name: "Old",
        world: "w",
        enabledMods: [],
        properties: {},
        jvm: { maxMemoryGb: 4, extraArgs: [] },
        createdAt: "x",
        updatedAt: "x",
      }),
    );
    await makeCtx();
    const p = await ctx.profiles.get("old");
    expect(p.runtime).toEqual({ loader: "fabric", minecraft: "26.2", loaderVersion: "0.19.5" });
    expect(p.clientMods).toEqual([]);
    expect(await fs.readFile(path.join(runtimeDir(), "eula.txt"), "utf8")).toContain("eula=true");
  });
});
