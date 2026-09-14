import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DaemonClient } from "../client.ts";
import { json } from "./util.ts";

// ─────────────── Read tools: grounded knowledge of the server's current state ───────────────

export function registerReadTools(mcp: McpServer, api: DaemonClient): void {
  mcp.registerTool(
    "status",
    {
      description:
        "Server status: running state, active profile (with its runtime), players online, setup state for that runtime (installed? Java? EULA?), LAN address, tunnel state, and every known runtime. Call this first.",
    },
    async () => json(await api.get("/status")),
  );

  mcp.registerTool(
    "tail_logs",
    {
      description:
        "Recent log lines from the daemon's ring buffer (server stdout/stderr, daemon notes, playit). Optional case-insensitive literal filter; separate alternatives with |.",
      inputSchema: {
        lines: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe("How many lines (default 200)"),
        grep: z
          .string()
          .max(256)
          .optional()
          .describe("Literal text or alternatives separated by |"),
      },
    },
    async ({ lines, grep }) => json(await api.get("/logs", { lines, grep })),
  );

  mcp.registerTool(
    "list_profiles",
    {
      description:
        "All profiles (runtime + world + enabled mods + client-only mods + modpack + memory) and which one is active.",
    },
    async () => json(await api.get("/profiles")),
  );

  mcp.registerTool(
    "list_runtimes",
    {
      description:
        "Installed and referenced server runtimes (loader + Minecraft version) with install/Java status, plus the presets the UI offers.",
    },
    async () => json(await api.get("/runtimes")),
  );

  mcp.registerTool(
    "list_mods",
    {
      description:
        "Mod library with parsed metadata (id, version, loader fabric|forge|neoforge, environment client|server|*) and, for a profile, whether each is enabled, client-only, and loader-compatible.",
      inputSchema: { profileId: z.string().optional().describe("Defaults to the active profile") },
    },
    async ({ profileId }) => json(await api.get("/mods", { profileId })),
  );

  mcp.registerTool(
    "get_players",
    { description: "Players currently online (from join/leave log lines)." },
    async () => json(await api.get("/server/players")),
  );

  mcp.registerTool(
    "list_worlds",
    { description: "Worlds under data/worlds and which one the focused runtime links to." },
    async () => json(await api.get("/worlds")),
  );

  mcp.registerTool(
    "tunnel_status",
    {
      description:
        "playit.gg / external tunnel state, including the public address to give remote players.",
    },
    async () => json(await api.get("/tunnel")),
  );

  mcp.registerTool(
    "job_status",
    {
      description:
        "Progress of a long-running job (modpack import, runtime install). Omit id to list recent jobs.",
      inputSchema: { id: z.string().optional() },
    },
    async ({ id }) => json(await api.get(id ? `/jobs/${encodeURIComponent(id)}` : "/jobs")),
  );

  mcp.registerTool(
    "list_log_files",
    {
      description:
        "Log files on disk: per-launch daemon logs, the focused runtime's own logs, and its crash reports.",
    },
    async () => json(await api.get("/logs/files")),
  );

  mcp.registerTool(
    "read_log_file",
    {
      description:
        "Bounded trailing text of a log file or crash report; decompresses .log.gz (see list_log_files for names).",
      inputSchema: {
        source: z.enum(["daemon", "server", "crash"]),
        name: z.string(),
        maxChars: z
          .number()
          .int()
          .min(1000)
          .max(2000000)
          .optional()
          .describe("Truncate to this many trailing characters (default 30000)"),
      },
    },
    async ({ source, name, maxChars }) => {
      const limit = maxChars ?? 30_000;
      const text = await api.text(
        `/logs/files/${source}/${encodeURIComponent(name)}?maxChars=${limit}`,
      );
      return {
        content: [
          {
            type: "text",
            text: text.length > limit ? `…(truncated)\n${text.slice(-limit)}` : text,
          },
        ],
      };
    },
  );

  mcp.registerTool(
    "recent_crash_report",
    {
      description:
        "Crash report matching the latest recorded launch, or a note that there is none. Use list_log_files for older incidents.",
    },
    async () => {
      const snapshot = (await api.get("/debug/snapshot")) as { latestCrashReport: string | null };
      return {
        content: [
          {
            type: "text",
            text:
              snapshot.latestCrashReport ?? "No crash report matching the latest recorded launch.",
          },
        ],
      };
    },
  );

  mcp.registerTool(
    "incident_history",
    {
      description:
        "Recent persisted server launches, stop causes, confirmed saves, forced exits and lag warnings. Survives manager restart.",
    },
    async () => json(await api.get("/server/incidents")),
  );

  mcp.registerTool(
    "debug_snapshot",
    {
      description:
        "Everything needed to diagnose a problem in one call: status, active profile, runtimes, mods with loader/environment, last 200 log lines, JVM args, effective server.properties, contents of the runtime's mods dir, log file list, newest crash report, recent jobs.",
    },
    async () => json(await api.get("/debug/snapshot")),
  );
}
