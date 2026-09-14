import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DaemonClient } from "../client.ts";
import { json } from "./util.ts";

const runtimeSchema = z
  .object({
    loader: z.enum(["fabric", "forge", "neoforge"]),
    minecraft: z.string().describe('e.g. "26.2" or "1.20.1"'),
    loaderVersion: z.string().describe('e.g. "0.19.5" (Fabric) or "47.4.0" (Forge)'),
  })
  .describe(
    "Which Minecraft + loader the profile runs. Each distinct loader+version gets its own server dir.",
  );

// ─────────────── Action tools: mutate the server. Each maps to one HTTP call. ───────────────

export function registerActionTools(mcp: McpServer, api: DaemonClient): void {
  mcp.registerTool(
    "save_server",
    {
      description:
        "Send save-all flush and wait up to 30 seconds for Minecraft to acknowledge the save. Leaves players connected.",
    },
    async () => json(await api.post("/server/save")),
  );
  mcp.registerTool(
    "start_server",
    {
      description:
        "Start the server with a profile (default: the active one). Materializes mods and the world junction first. Fails with RUNTIME_MISSING / EULA_REQUIRED / JAVA_UNSUPPORTED / SERVER_RUNNING.",
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
      description:
        "Enable or disable a library jar in a profile. side=server (loaded by the server, default) or client (export-only extra). Takes effect on the next start.",
      inputSchema: {
        profileId: z.string(),
        file: z.string().describe("Jar filename from list_mods"),
        enabled: z.boolean(),
        side: z.enum(["server", "client"]).optional(),
      },
    },
    async ({ profileId, file, enabled, side }) =>
      json(
        await api.post(`/profiles/${encodeURIComponent(profileId)}/mods`, { file, enabled, side }),
      ),
  );

  mcp.registerTool(
    "switch_profile",
    {
      description:
        "Make a profile the active one for the next start (this is how you swap Fabric ↔ Forge). Refused while the server is running.",
      inputSchema: { profileId: z.string() },
    },
    async ({ profileId }) =>
      json(await api.post(`/profiles/${encodeURIComponent(profileId)}/activate`)),
  );

  mcp.registerTool(
    "create_profile",
    {
      description:
        "Create a profile. `world` is a folder under data/worlds (created on first start if missing). Omit runtime for Fabric 26.2.",
      inputSchema: {
        name: z.string().min(1),
        runtime: runtimeSchema.optional(),
        world: z.string().optional(),
        enabledMods: z.array(z.string()).optional(),
        maxMemoryGb: z.number().int().min(1).optional(),
        properties: z.record(z.string(), z.string()).optional(),
      },
    },
    async ({ name, runtime, world, enabledMods, maxMemoryGb, properties }) =>
      json(
        await api.post("/profiles", {
          name,
          runtime,
          world,
          enabledMods,
          properties,
          jvm: maxMemoryGb ? { maxMemoryGb, extraArgs: [] } : undefined,
        }),
      ),
  );

  mcp.registerTool(
    "install_runtime",
    {
      description:
        "Download and install a server runtime (Fabric launcher, or Forge/NeoForge via their installer). Returns a job; poll job_status.",
      inputSchema: { runtime: runtimeSchema },
    },
    async ({ runtime }) => json(await api.post("/runtimes/install", { runtime })),
  );

  mcp.registerTool(
    "import_modpack",
    {
      description:
        "Import a Modrinth modpack (URL, slug, or direct .mrpack URL): downloads the pack, installs its runtime if needed, pulls the server-side jars into the library, applies overrides, and creates a profile. Returns a job; poll job_status. Takes minutes for big packs.",
      inputSchema: {
        source: z
          .string()
          .describe(
            "e.g. https://modrinth.com/modpack/society-sunlit-valley or society-sunlit-valley",
          ),
        profileName: z.string().optional(),
        world: z.string().optional(),
        maxMemoryGb: z.number().int().min(1).optional(),
      },
    },
    async (args) => json(await api.post("/modpacks/import", args)),
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
        "Build the client pack zip for a profile under data/exports: loose jars clients need, plus the .mrpack for modpack profiles, plus a README with the server address.",
      inputSchema: { profileId: z.string().optional() },
    },
    async ({ profileId }) => json(await api.post("/export/client-zip", { profileId })),
  );

  mcp.registerTool(
    "whitelist_add",
    {
      description:
        "Resolve Minecraft usernames via Mojang and add them to whitelist.json in EVERY runtime dir (Fabric and Forge alike); reloads the whitelist if a server is running. Reports names with no account.",
      inputSchema: { names: z.array(z.string()).min(1) },
    },
    async ({ names }) => json(await api.post("/whitelist", { names })),
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
