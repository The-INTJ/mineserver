import type { Runtime } from "./types.ts";

// Fabric's server "launcher" bootstrap jar; version-independent.
export const FABRIC_INSTALLER_VERSION = "1.1.2";

/** The runtime a fresh install gets, and what the "default" profile uses. */
export const DEFAULT_RUNTIME: Runtime = {
  loader: "fabric",
  minecraft: "26.2",
  loaderVersion: "0.19.5",
};

/** Presets offered in the UI dropdown. Anything else can be typed in as a custom runtime. */
export const RUNTIME_PRESETS: { label: string; runtime: Runtime; note?: string }[] = [
  { label: "Fabric 26.2", runtime: DEFAULT_RUNTIME },
  {
    label: "Forge 1.20.1 (47.4.0)",
    runtime: { loader: "forge", minecraft: "1.20.1", loaderVersion: "47.4.0" },
    note: "The big-modpack LTS version (Sunlit Valley, ATM9). Needs Java 17.",
  },
  {
    label: "NeoForge 1.21.1 (21.1.209)",
    runtime: { loader: "neoforge", minecraft: "1.21.1", loaderVersion: "21.1.209" },
    note: "Untested here; the 1.21 modpack platform. Needs Java 21.",
  },
];

// playit.gg agent. 0.17.x is the last single-binary line; 1.0.x installs a
// Windows service under C:\ProgramData, which we don't want (everything under data/).
export const PLAYIT_VERSION = "0.17.1";
export const PLAYIT_URL = `https://github.com/playit-cloud/playit-agent/releases/download/v${PLAYIT_VERSION}/playit-windows-x86_64-signed.exe`;
export const PLAYIT_SIZE_BYTES = 5_094_152;

export const DAEMON_PORT = 3400;
export const MINECRAFT_PORT = 25565;
export const DEFAULT_MAX_MEMORY_GB = 4;
export const LOG_RING_SIZE = 2000;
export const STOP_TIMEOUT_MS = 60_000;
// First launch downloads the vanilla server jar and generates the world; be generous.
export const READY_TIMEOUT_MS = 10 * 60_000;

/** Modrinth asks for a descriptive User-Agent. */
export const MODRINTH_USER_AGENT = "mineserver/0.1 (github.com/The-INTJ/mineserver)";
