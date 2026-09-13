import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DaemonClient } from "./client.ts";
import { registerActionTools } from "./tools/action.ts";
import { registerReadTools } from "./tools/read.ts";

/**
 * MCP server over stdio. Register with Claude Code:
 *   claude mcp add mineserver -- node E:/Coding/mineserver/dist/mcp/main.js
 * Requires the daemon to be running (npm run dev / npm start); set MINESERVER_URL to override.
 */
const api = new DaemonClient();
const mcp = new McpServer({ name: "mineserver", version: "0.1.0" });
registerReadTools(mcp, api);
registerActionTools(mcp, api);

const transport = new StdioServerTransport();
await mcp.connect(transport);
console.error(`mineserver MCP ready (daemon at ${api.baseUrl})`);
