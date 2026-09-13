import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  DebugSnapshot,
  LogFileInfo,
  ModInLibraryWithState,
  StatusResponse,
} from "../shared/types.ts";
import { LOADER_VERSION, MC_VERSION, MINECRAFT_PORT } from "../shared/constants.ts";
import type { AppContext } from "./context.ts";
import { eulaAccepted } from "./fabric/eula.ts";
import { launcherPresent } from "./fabric/fabric-launcher.ts";
import { probeJava } from "./fabric/java-info.ts";
import { exists } from "./fsx.ts";
import { lanIp } from "./lan.ts";

export async function buildStatus(ctx: AppContext): Promise<StatusResponse> {
  const server = ctx.server.getState();
  const java = await probeJava(ctx.javaPath);
  const activeProfile = server.activeProfileId
    ? await ctx.profiles.get(server.activeProfileId).catch(() => null)
    : null;
  return {
    server,
    activeProfile,
    setup: {
      javaPath: ctx.javaPath,
      javaVersion: java.version,
      javaMajor: java.major,
      javaOk: java.ok,
      eulaAccepted: await eulaAccepted(ctx.paths.server),
      launcherJarPresent: await launcherPresent(ctx.paths.server),
      dataDir: ctx.paths.data,
      minecraftDir: ctx.paths.minecraftDir,
      minecraftDirPresent: await exists(ctx.paths.minecraftDir),
    },
    lan: { ip: lanIp(), port: MINECRAFT_PORT },
    tunnel: await ctx.tunnel.getState(),
    versions: { minecraft: MC_VERSION, loader: LOADER_VERSION },
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
  await scan(ctx.paths.serverLogs, "server", (n) => n.endsWith(".log") || n.endsWith(".log.gz"));
  await scan(ctx.paths.serverCrashReports, "crash", (n) => n.endsWith(".txt"));
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export function logFileDir(ctx: AppContext, source: LogFileInfo["source"]): string {
  return source === "daemon"
    ? ctx.paths.logs
    : source === "server"
      ? ctx.paths.serverLogs
      : ctx.paths.serverCrashReports;
}

export async function modsWithState(
  ctx: AppContext,
  profileId: string | null,
): Promise<ModInLibraryWithState[]> {
  const mods = await ctx.library.list();
  const enabled = new Set(
    profileId ? ((await ctx.profiles.get(profileId).catch(() => null))?.enabledMods ?? []) : [],
  );
  return mods.map((m) => ({ ...m, enabled: enabled.has(m.file) }));
}

/** One blob with everything an AI (or a human) needs to diagnose "it won't start". */
export async function buildSnapshot(ctx: AppContext): Promise<DebugSnapshot> {
  const status = await buildStatus(ctx);
  const logFiles = await listLogFiles(ctx);
  const crash = logFiles.find((f) => f.source === "crash");
  let latestCrashReport: string | null = null;
  if (crash) {
    const text = await fs
      .readFile(path.join(ctx.paths.serverCrashReports, crash.name), "utf8")
      .catch(() => "");
    latestCrashReport = text.slice(0, 20_000);
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
    serverModsDir: await fs.readdir(ctx.paths.serverMods).catch(() => [] as string[]),
  };
}
