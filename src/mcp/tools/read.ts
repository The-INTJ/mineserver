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
        "Server status: running state, active profile, players online, Java/EULA/launcher setup, LAN address, tunnel state and pinned versions. Call this first.",
    },
    async () => json(await api.get("/status")),
  );

  mcp.registerTool(
    "tail_logs",
    {
      description:
        "Recent log lines from the daemon's ring buffer (server stdout/stderr, daemon notes, playit). Optional case-insensitive regex filter.",
      inputSchema: {
        lines: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe("How many lines (default 200)"),
        grep: z.string().optional().describe("Regex; only matching lines are returned"),
      },
    },
    async ({ lines, grep }) => json(await api.get("/logs", { lines, grep })),
  );

  mcp.registerTool(
    "list_profiles",
    {
      description:
        "All profiles (world + enabled mods + property overrides + JVM memory) and which one is active.",
    },
    async () => json(await api.get("/profiles")),
  );

  mcp.registerTool(
    "list_mods",
    {
      description:
        "Mod library with parsed fabric.mod.json metadata (id, version, environment client|server|*) and whether each is enabled in a profile.",
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
    { description: "Worlds under data/worlds and which one is linked as active." },
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
    "list_log_files",
    {
      description:
        "Log files on disk: per-launch daemon logs, the game's own logs, and crash reports.",
    },
    async () => json(await api.get("/logs/files")),
  );

  mcp.registerTool(
    "read_log_file",
    {
      description: "Full text of one log file or crash report (see list_log_files for names).",
      inputSchema: {
        source: z.enum(["daemon", "server", "crash"]),
        name: z.string(),
        maxChars: z
          .number()
          .int()
          .optional()
          .describe("Truncate to this many trailing characters (default 30000)"),
      },
    },
    async ({ source, name, maxChars }) => {
      const text = await api.text(`/logs/files/${source}/${encodeURIComponent(name)}`);
      const limit = maxChars ?? 30_000;
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
    { description: "Newest crash report text, or a note that there is none." },
    async () => {
      const { files } = (await api.get("/logs/files")) as {
        files: { name: string; source: string }[];
      };
      const crash = files.find((f) => f.source === "crash");
      if (!crash) return { content: [{ type: "text", text: "No crash reports." }] };
      const text = await api.text(`/logs/files/crash/${encodeURIComponent(crash.name)}`);
      return { content: [{ type: "text", text: `# ${crash.name}\n${text.slice(0, 30_000)}` }] };
    },
  );

  mcp.registerTool(
    "debug_snapshot",
    {
      description:
        "Everything needed to diagnose a problem in one call: status, active profile, mods with environments, last 200 log lines, JVM args, effective server.properties, contents of the server mods dir, log file list, newest crash report.",
    },
    async () => json(await api.get("/debug/snapshot")),
  );
}
