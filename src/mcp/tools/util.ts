import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Tools return pretty JSON strings, same habit as the Python FastMCP servers in this workspace. */
export function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
