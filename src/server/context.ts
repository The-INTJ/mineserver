import { ensureDirs, resolvePaths, type Paths } from "./config.ts";
import { JobRegistry } from "./jobs.ts";
import { ModLibrary } from "./mods/mod-library.ts";
import { LogBuffer } from "./process/log-buffer.ts";
import { ServerManager } from "./process/server-manager.ts";
import { ProfileStore } from "./profiles/profile-store.ts";
import { RuntimeStore } from "./runtime/runtime-store.ts";
import { StateStore } from "./state-store.ts";
import { TunnelManager } from "./tunnel/tunnel.ts";
import { WorldStore } from "./worlds/world-store.ts";

/** Every long-lived service, built once in main.ts and threaded into the routes. */
export interface AppContext {
  paths: Paths;
  logs: LogBuffer;
  state: StateStore;
  profiles: ProfileStore;
  library: ModLibrary;
  worlds: WorldStore;
  runtimes: RuntimeStore;
  server: ServerManager;
  tunnel: TunnelManager;
  jobs: JobRegistry;
}

export interface ContextOptions {
  dataDir?: string;
  spawnOverride?: { javaPath: string; args: string[] };
}

export async function createContext(opts: ContextOptions = {}): Promise<AppContext> {
  const paths = resolvePaths(opts.dataDir);
  await ensureDirs(paths);
  const logs = new LogBuffer();
  const state = new StateStore(paths.stateFile);
  const profiles = new ProfileStore(paths.profiles);
  const library = new ModLibrary(paths.modLibrary, paths.modLibraryIndex);
  const worlds = new WorldStore(paths.worlds, paths.minecraftSaves);
  const runtimes = new RuntimeStore(paths.servers, logs);
  const server = new ServerManager({
    paths,
    logs,
    state,
    profiles,
    library,
    worlds,
    runtimes,
    spawnOverride: opts.spawnOverride,
  });
  const tunnel = new TunnelManager(paths.playit, logs);
  const jobs = new JobRegistry();
  await profiles.ensureDefault();
  await server.init();
  await tunnel.init();
  return { paths, logs, state, profiles, library, worlds, runtimes, server, tunnel, jobs };
}
