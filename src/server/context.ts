import { ensureDirs, findJava, resolvePaths, type Paths } from "./config.ts";
import { ModLibrary } from "./mods/mod-library.ts";
import { LogBuffer } from "./process/log-buffer.ts";
import { ServerManager } from "./process/server-manager.ts";
import { ProfileStore } from "./profiles/profile-store.ts";
import { StateStore } from "./state-store.ts";
import { TunnelManager } from "./tunnel/tunnel.ts";
import { WorldStore } from "./worlds/world-store.ts";

/** Every long-lived service, built once in main.ts and threaded into the routes. */
export interface AppContext {
  paths: Paths;
  javaPath: string;
  logs: LogBuffer;
  state: StateStore;
  profiles: ProfileStore;
  library: ModLibrary;
  worlds: WorldStore;
  server: ServerManager;
  tunnel: TunnelManager;
}

export interface ContextOptions {
  dataDir?: string;
  javaPath?: string;
  spawnOverride?: { javaPath: string; args: string[] };
}

export async function createContext(opts: ContextOptions = {}): Promise<AppContext> {
  const paths = resolvePaths(opts.dataDir);
  await ensureDirs(paths);
  const javaPath = opts.javaPath ?? (await findJava());
  const logs = new LogBuffer();
  const state = new StateStore(paths.stateFile);
  const profiles = new ProfileStore(paths.profiles);
  const library = new ModLibrary(paths.modLibrary, paths.modLibraryIndex);
  const worlds = new WorldStore(paths.worlds, paths.serverWorldLink, paths.minecraftSaves);
  const server = new ServerManager({
    paths,
    logs,
    state,
    profiles,
    library,
    worlds,
    javaPath,
    spawnOverride: opts.spawnOverride,
  });
  const tunnel = new TunnelManager(paths.playit, logs);
  await server.init();
  await tunnel.init();
  await profiles.ensureDefault();
  return { paths, javaPath, logs, state, profiles, library, worlds, server, tunnel };
}
