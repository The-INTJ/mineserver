// Pinned versions. Bump together; the launcher URL encodes all three.
export const MC_VERSION = "26.2";
export const LOADER_VERSION = "0.19.5";
export const INSTALLER_VERSION = "1.1.2";
export const FABRIC_LAUNCHER_URL = `https://meta.fabricmc.net/v2/versions/loader/${MC_VERSION}/${LOADER_VERSION}/${INSTALLER_VERSION}/server/jar`;
export const FABRIC_LAUNCHER_FILENAME = "fabric-server-launch.jar";

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
