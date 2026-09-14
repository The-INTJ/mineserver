import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  DebugSnapshot,
  LogFileInfo,
  ModInLibraryWithState,
  Profile,
  Runtime,
  RuntimeInfo,
  StatusResponse,
} from "../shared/types.ts";
import { MINECRAFT_PORT } from "../shared/constants.ts";
import type { AppContext } from "./context.ts";
import { exists } from "./fsx.ts";
import { lanIp } from "./lan.ts";
import { loaderCompatible, parseRuntimeId } from "./runtime/runtimes.ts";

/** The profile whose runtime the setup panel and log listings refer to. */
export async function focusProfile(ctx: AppContext): Promise<Profile | null> {
  const id = ctx.server.getState().activeProfileId;
  if (id) return ctx.profiles.get(id).catch(() => null);
  return ctx.profiles.get("default").catch(() => null);
}

/** Runtimes: every profile's, plus any leftover installed dir. */
export async function listRuntimes(ctx: AppContext): Promise<RuntimeInfo[]> {
  const seen = new Map<string, Runtime>();
  for (const p of await ctx.profiles.list())
    seen.set(`${p.runtime.loader}-${p.runtime.minecraft}`, p.runtime);
  for (const id of await ctx.runtimes.listInstalledIds()) {
    if (seen.has(id)) continue;
    const parsed = parseRuntimeId(id);
    if (parsed) seen.set(id, { ...parsed, loaderVersion: "?" });
  }
  const out: RuntimeInfo[] = [];
  for (const rt of seen.values()) out.push(await ctx.runtimes.info(rt));
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export async function buildStatus(ctx: AppContext): Promise<StatusResponse> {
  const server = ctx.server.getState();
  const activeProfile = server.activeProfileId
    ? await ctx.profiles.get(server.activeProfileId).catch(() => null)
    : null;
  const focus = activeProfile ?? (await focusProfile(ctx));
  const runtime = await ctx.runtimes.info(
    focus?.runtime ?? (await ctx.profiles.ensureDefault()).runtime,
  );
  const persisted = await ctx.state.get();
  return {
    server,
    reliability: ctx.server.reliability(),
    backups: ctx.backups.status(),
    activeProfile,
    setup: {
      runtime,
      eulaAccepted: persisted.eulaAccepted || runtime.eulaAccepted,
      dataDir: ctx.paths.data,
      minecraftDir: ctx.paths.minecraftDir,
      minecraftDirPresent: await exists(ctx.paths.minecraftDir),
    },
    lan: { ip: lanIp(), port: MINECRAFT_PORT },
    tunnel: await ctx.tunnel.getState(),
    runtimes: await listRuntimes(ctx),
  };
}

export async function listLogFiles(ctx: AppContext): Promise<LogFileInfo[]> {
  const out: LogFileInfo[] = [];
  const scan = async (
    dir: string,
    source: LogFileInfo["source"],
    filter: (n: string) => boolean,
  ) => {
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!filter(name)) continue;
      const st = await fs.stat(path.join(dir, name)).catch(() => null);
      if (!st?.isFile()) continue;
      out.push({ name, source, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() });
    }
  };
  await scan(ctx.paths.logs, "daemon", (n) => n.endsWith(".log"));
  const rt = await focusRuntimePaths(ctx);
  if (rt) {
    await scan(rt.logs, "server", (n) => n.endsWith(".log") || n.endsWith(".log.gz"));
    await scan(rt.crashReports, "crash", (n) => n.endsWith(".txt"));
  }
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export async function focusRuntimePaths(ctx: AppContext) {
  const rt = ctx.server.activeRuntime ?? (await focusProfile(ctx))?.runtime ?? null;
  return rt ? ctx.runtimes.paths(rt) : null;
}

export async function logFileDir(
  ctx: AppContext,
  source: LogFileInfo["source"],
): Promise<string | null> {
  if (source === "daemon") return ctx.paths.logs;
  const rt = await focusRuntimePaths(ctx);
  if (!rt) return null;
  return source === "server" ? rt.logs : rt.crashReports;
}

export async function modsWithState(
  ctx: AppContext,
  profileId: string | null,
): Promise<ModInLibraryWithState[]> {
  const mods = await ctx.library.list();
  const profile = profileId ? await ctx.profiles.get(profileId).catch(() => null) : null;
  const enabled = new Set(profile?.enabledMods ?? []);
  const client = new Set(profile?.clientMods ?? []);
  return mods.map((m) => ({
    ...m,
    enabled: enabled.has(m.file),
    clientOnly: client.has(m.file),
    compatible: profile ? loaderCompatible(m.loaders, profile.runtime) : true,
  }));
}

/** One blob with everything an AI (or a human) needs to diagnose "it won't start". */
export async function buildSnapshot(ctx: AppContext): Promise<DebugSnapshot> {
  const status = await buildStatus(ctx);
  const logFiles = await listLogFiles(ctx);
  const run = ctx.server.incidents.current;
  const crash = logFiles.find(
    (f) =>
      f.source === "crash" &&
      run &&
      f.modifiedAt >= run.startedAt &&
      (!run.endedAt || f.modifiedAt <= run.endedAt),
  );
  let latestCrashReport: string | null = null;
  const rt = await focusRuntimePaths(ctx);
  if (crash && rt) {
    const file = await fs.open(path.join(rt.crashReports, crash.name), "r").catch(() => null);
    if (file) {
      try {
        const buffer = Buffer.alloc(20000);
        const { bytesRead } = await file.read(buffer);
        latestCrashReport = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await file.close();
      }
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    status,
    activeProfile: status.activeProfile,
    mods: await modsWithState(ctx, status.server.activeProfileId),
    recentLogs: ctx.logs.tail(200),
    jvmArgs: ctx.server.lastJvmArgs,
    logFiles,
    latestCrashReport,
    serverPropertiesEffective: ctx.server.lastEffectiveProperties,
    serverModsDir: rt ? await fs.readdir(rt.mods).catch(() => [] as string[]) : [],
    jobs: ctx.jobs.list(),
  };
}
