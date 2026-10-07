// Contract shared by the daemon (src/server), the UI (src/ui) and the MCP server (src/mcp).
// Keep this file runtime-neutral: no Node or React imports.

export type Loader = "fabric" | "forge" | "neoforge";

/** Which Minecraft + mod loader a profile runs on. Each distinct (loader, minecraft) gets its own server dir. */
export interface Runtime {
  loader: Loader;
  minecraft: string;
  loaderVersion: string;
}

export interface RuntimeInfo extends Runtime {
  /** `${loader}-${minecraft}`; also the folder name under data/servers. */
  id: string;
  dir: string;
  installed: boolean;
  /** Java major the game needs (8/16/17/21/25). */
  javaMajor: number;
  javaPath: string | null;
  javaVersion: string | null;
  javaOk: boolean;
  eulaAccepted: boolean;
}

export type ModLoaderTag = "fabric" | "forge" | "neoforge" | "multi" | "unknown";
export type ModEnvironment = "client" | "server" | "*";

/** One jar in the shared mod library (data/mods/library). */
export interface ModEntry {
  /** Basename inside the library dir; the unique key everywhere else. */
  file: string;
  id: string;
  version: string;
  name: string;
  /** Display tag: the loader, "multi" when the jar ships several manifests, "unknown" when none parsed. */
  loader: ModLoaderTag;
  /** Every loader the jar can load on (empty when unknown; such jars are allowed everywhere). */
  loaders: Loader[];
  /** From fabric.mod.json `environment`; Forge jars are always "*". */
  environment: ModEnvironment;
  sizeBytes: number;
  addedAt: string;
  /** Set when no manifest could be parsed; the jar is kept but flagged. */
  parseError?: string;
}

export interface ProfileJvm {
  maxMemoryGb: number;
  extraArgs: string[];
}

export interface ModpackRef {
  name: string;
  version: string;
  /** Where it came from (Modrinth URL or local upload name). */
  source: string;
  /** Filename under data/modpacks. */
  file: string;
}

/** A profile = one runtime + one world + one enabled-mod set + server.properties overrides. */
export interface Profile {
  /** Slug, immutable, also the filename under data/profiles. */
  id: string;
  name: string;
  runtime: Runtime;
  /** Folder name under data/worlds. */
  world: string;
  /** ModEntry.file values loaded by the server. */
  enabledMods: string[];
  /** ModEntry.file values that only clients need (shipped in the export, never loaded by the server). */
  clientMods: string[];
  /** Merged over templates/server.properties.default. level-name and white-list are forced. */
  properties: Record<string, string>;
  jvm: ProfileJvm;
  modpack?: ModpackRef;
  createdAt: string;
  updatedAt: string;
}

export type ProfileInput = Pick<Profile, "name"> &
  Partial<
    Pick<
      Profile,
      "runtime" | "world" | "enabledMods" | "clientMods" | "properties" | "jvm" | "modpack"
    >
  >;

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
  /** Runtime of the active profile (or the default profile when none is active). */
  runtime: RuntimeInfo;
  eulaAccepted: boolean;
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
  | "off"
  | "not_installed"
  | "unclaimed"
  | "claiming"
  | "stopped"
  | "starting"
  | "running"
  | "configured"
  | "error";

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

/** mineserver's own periodic world archives, for profiles without a backup mod. */
export interface WorldBackupStatus {
  enabled: boolean;
  /** 0 when disabled via `worldBackupIntervalMinutes: 0` in data/reliability.json. */
  intervalMinutes: number;
  /** Archives kept per world in <runtime>/backups (the mirror keeps more). */
  keep: number;
  busy: boolean;
  lastFile: string | null;
  lastAt: string | null;
  lastError: string | null;
  /** Set when the active profile's own backup mod (FTB Backups) is responsible instead. */
  skippedReason: string | null;
}

export interface StatusResponse {
  reliability?: ReliabilityStatus;
  backups?: {
    enabled: boolean;
    directory: string | null;
    lastSuccessAt: string | null;
    lastBackupAt: string | null;
    lastError: string | null;
    copies: number;
    busy: boolean;
    restoreVerifiedAt: string | null;
  };
  worldBackup?: WorldBackupStatus;
  server: ServerState;
  activeProfile: Profile | null;
  setup: SetupState;
  lan: LanInfo;
  tunnel: TunnelState;
  runtimes: RuntimeInfo[];
}

export interface LogFileInfo {
  name: string;
  /** "daemon" = data/logs, "server" = <runtime>/logs, "crash" = <runtime>/crash-reports */
  source: "daemon" | "server" | "crash";
  sizeBytes: number;
  modifiedAt: string;
}

export interface ExportResult {
  file: string;
  sizeBytes: number;
  includedMods: string[];
  excludedServerOnly: string[];
  modpackIncluded: string | null;
}

export interface ClientSyncResult {
  copied: string[];
  removed: string[];
  targetDir: string;
}

export interface ModInLibraryWithState extends ModEntry {
  enabled: boolean;
  clientOnly: boolean;
  /** False when the jar's loader cannot run on the profile's runtime. */
  compatible: boolean;
}

/** Long-running work (modpack import, runtime install) tracked by id; UI and MCP poll it. */
export type JobStatus = "running" | "done" | "error";
export interface Job {
  id: string;
  kind: string;
  title: string;
  status: JobStatus;
  startedAt: string;
  finishedAt: string | null;
  /** Latest progress line. */
  message: string;
  /** 0..1 when known. */
  progress: number | null;
  result: unknown;
  error: string | null;
}

export interface ModpackImportResult {
  profileId: string;
  runtime: RuntimeInfo;
  serverMods: string[];
  clientMods: string[];
  skippedNonMods: string[];
  overrideFiles: number;
  modpack: ModpackRef;
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
  jobs: Job[];
}

export interface ApiError {
  error: string;
  code: string;
}

export interface RunRecord {
  id: string;
  profileId: string;
  runtime: string;
  startedAt: string;
  readyAt: string | null;
  endedAt: string | null;
  pid: number | null;
  code: number | null;
  signal: string | null;
  reason: string | null;
  outcome: "starting" | "running" | "stopped" | "crashed" | "forced" | "unclean";
  forced: boolean;
  saveConfirmedAt: string | null;
  lagWarnings: number;
  worstLagMs: number;
  logFile: string | null;
}

export interface ReliabilityStatus {
  run: RunRecord | null;
  loggingError: string | null;
  recovery: {
    enabled: boolean;
    attempts: number;
    nextAttemptAt: string | null;
    blockedReason: string | null;
  };
}
