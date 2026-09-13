// Contract shared by the daemon (src/server), the UI (src/ui) and the MCP server (src/mcp).
// Keep this file runtime-neutral: no Node or React imports.

export type ModEnvironment = "client" | "server" | "*";

/** One jar in the shared mod library (data/mods/library). */
export interface ModEntry {
  /** Basename inside the library dir; the unique key everywhere else. */
  file: string;
  id: string;
  version: string;
  name: string;
  /** From fabric.mod.json `environment`; absent means "*". */
  environment: ModEnvironment;
  sizeBytes: number;
  addedAt: string;
  /** Set when fabric.mod.json is missing or unparseable; the jar is kept but flagged. */
  parseError?: string;
}

export interface ProfileJvm {
  maxMemoryGb: number;
  extraArgs: string[];
}

/** A profile = one world + one enabled-mod set + server.properties overrides. */
export interface Profile {
  /** Slug, immutable, also the filename under data/profiles. */
  id: string;
  name: string;
  /** Folder name under data/worlds. */
  world: string;
  /** ModEntry.file values. */
  enabledMods: string[];
  /** Merged over templates/server.properties.default. level-name and white-list are forced. */
  properties: Record<string, string>;
  jvm: ProfileJvm;
  createdAt: string;
  updatedAt: string;
}

export type ProfileInput = Pick<Profile, "name"> &
  Partial<Pick<Profile, "world" | "enabledMods" | "properties" | "jvm">>;

export type ServerStatus = "stopped" | "starting" | "running" | "stopping" | "crashed";

export interface ServerState {
  status: ServerStatus;
  activeProfileId: string | null;
  pid: number | null;
  startedAt: string | null;
  readyAt: string | null;
  players: string[];
  lastExitCode: number | null;
  /** Human-readable reason for the last stop/crash, e.g. "EULA not accepted". */
  lastStopReason: string | null;
}

export interface PersistedState {
  activeProfileId: string | null;
  lastStartedAt: string | null;
  eulaAccepted: boolean;
}

export interface SetupState {
  javaPath: string;
  javaVersion: string | null;
  javaMajor: number | null;
  javaOk: boolean;
  eulaAccepted: boolean;
  launcherJarPresent: boolean;
  dataDir: string;
  minecraftDir: string;
  minecraftDirPresent: boolean;
}

export type LogKind = "done" | "join" | "leave" | "chat" | "crash" | "eula" | "other";
export type LogLevel = "INFO" | "WARN" | "ERROR" | "FATAL" | "DEBUG" | "RAW";

export interface LogLine {
  seq: number;
  /** ISO timestamp when the daemon received the line. */
  ts: string;
  stream: "stdout" | "stderr" | "daemon";
  text: string;
  level: LogLevel;
  kind: LogKind;
  player?: string;
}

export interface WorldInfo {
  name: string;
  sizeBytes: number;
  hasLevelDat: boolean;
  modifiedAt: string;
}

export interface ImportCandidate {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

export type TunnelMode = "off" | "playit" | "external";
export type TunnelStatus =
  "off" | "not_installed" | "unclaimed" | "claiming" | "stopped" | "starting" | "running" | "error";

export interface TunnelState {
  mode: TunnelMode;
  status: TunnelStatus;
  binaryPresent: boolean;
  secretPresent: boolean;
  claim: { code: string; url: string; startedAt: string } | null;
  /** playit: parsed from `tunnels list`; external: user-entered. */
  publicAddress: string | null;
  tunnelId: string | null;
  error: string | null;
  pid: number | null;
}

export interface LanInfo {
  ip: string | null;
  port: number;
}

export interface StatusResponse {
  server: ServerState;
  activeProfile: Profile | null;
  setup: SetupState;
  lan: LanInfo;
  tunnel: TunnelState;
  versions: { minecraft: string; loader: string };
}

export interface LogFileInfo {
  name: string;
  /** "daemon" = data/logs, "server" = data/server/logs, "crash" = data/server/crash-reports */
  source: "daemon" | "server" | "crash";
  sizeBytes: number;
  modifiedAt: string;
}

export interface ExportResult {
  file: string;
  sizeBytes: number;
  includedMods: string[];
  excludedServerOnly: string[];
}

export interface ClientSyncResult {
  copied: string[];
  removed: string[];
  targetDir: string;
}

export interface ModInLibraryWithState extends ModEntry {
  enabled: boolean;
}

/** Everything an AI needs in one blob to diagnose a problem. */
export interface DebugSnapshot {
  generatedAt: string;
  status: StatusResponse;
  activeProfile: Profile | null;
  mods: ModInLibraryWithState[];
  recentLogs: LogLine[];
  jvmArgs: string[];
  logFiles: LogFileInfo[];
  latestCrashReport: string | null;
  serverPropertiesEffective: Record<string, string> | null;
  serverModsDir: string[];
}

export interface ApiError {
  error: string;
  code: string;
}
