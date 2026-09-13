import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DaemonClient } from "../client.ts";
import { json } from "./util.ts";

// ─────────────── Action tools: mutate the server. Each maps to one HTTP call. ───────────────

export function registerActionTools(mcp: McpServer, api: DaemonClient): void {
  mcp.registerTool(
    "start_server",
    {
      description:
        "Start the Fabric server with a profile (default: the active one). Materializes mods and the world junction first. Fails with EULA_REQUIRED / LAUNCHER_MISSING / JAVA_UNSUPPORTED / SERVER_RUNNING.",
      inputSchema: { profileId: z.string().optional() },
    },
    async ({ profileId }) => json(await api.post("/server/start", { profileId })),
  );

  mcp.registerTool(
    "stop_server",
    { description: "Graceful stop: sends `stop`, waits up to 60s, then kills the process tree." },
    async () => json(await api.post("/server/stop")),
  );

  mcp.registerTool(
    "restart_server",
    { description: "Stop then start the same profile." },
    async () => json(await api.post("/server/restart")),
  );

  mcp.registerTool(
    "send_command",
    {
      description:
        "Send a console command to the running server's stdin (no leading slash needed), e.g. `whitelist add Name`, `say hi`, `list`.",
      inputSchema: { command: z.string().min(1) },
    },
    async ({ command }) => json(await api.post("/server/command", { command })),
  );

  mcp.registerTool(
    "set_mod_enabled",
    {
      description: "Enable or disable a library jar in a profile. Takes effect on the next start.",
      inputSchema: {
        profileId: z.string(),
        file: z.string().describe("Jar filename from list_mods"),
        enabled: z.boolean(),
      },
    },
    async ({ profileId, file, enabled }) =>
      json(await api.post(`/profiles/${encodeURIComponent(profileId)}/mods`, { file, enabled })),
  );

  mcp.registerTool(
    "switch_profile",
    {
      description:
        "Make a profile the active one for the next start. Refused while the server is running.",
      inputSchema: { profileId: z.string() },
    },
    async ({ profileId }) =>
      json(await api.post(`/profiles/${encodeURIComponent(profileId)}/activate`)),
  );

  mcp.registerTool(
    "create_profile",
    {
      description:
        "Create a profile. `world` is a folder under data/worlds (created on first start if missing).",
      inputSchema: {
        name: z.string().min(1),
        world: z.string().optional(),
        enabledMods: z.array(z.string()).optional(),
        maxMemoryGb: z.number().int().min(1).optional(),
        properties: z.record(z.string(), z.string()).optional(),
      },
    },
    async ({ name, world, enabledMods, maxMemoryGb, properties }) =>
      json(
        await api.post("/profiles", {
          name,
          world,
          enabledMods,
          properties,
          jvm: maxMemoryGb ? { maxMemoryGb, extraArgs: [] } : undefined,
        }),
      ),
  );

  mcp.registerTool(
    "import_world",
    {
      description:
        "Copy a single-player save from the local .minecraft/saves into data/worlds. Never links.",
      inputSchema: { sourceName: z.string(), targetName: z.string().optional() },
    },
    async ({ sourceName, targetName }) =>
      json(await api.post("/worlds/import", { sourceName, targetName })),
  );

  mcp.registerTool(
    "export_client_zip",
    {
      description:
        "Build the client mod pack zip for a profile (server-only mods excluded) under data/exports.",
      inputSchema: { profileId: z.string().optional() },
    },
    async ({ profileId }) => json(await api.post("/export/client-zip", { profileId })),
  );

  mcp.registerTool(
    "import_client_mods",
    {
      description:
        "Import every jar from the local %APPDATA%\\.minecraft\\mods into the library (skips existing filenames).",
    },
    async () => json(await api.post("/mods/import-client")),
  );
}
