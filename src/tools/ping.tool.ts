import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const inputShape = {
  msg: z.string().min(1).max(200).describe("Message to echo back"),
};

const outputShape = {
  reply: z.string().describe("'pong: <msg>'"),
};

export function registerPingTool(server: McpServer): void {
  server.registerTool(
    "ping",
    {
      title: "Health check",
      description:
        "PRIMARY tool for connection sanity-check: returns 'pong: <msg>'. " +
        "DISTINCT from weeek_get_me — ping makes NO Weeek API call (no token " +
        "required, no network), so it stays green even when WEEEK_ACCESS_TOKEN " +
        "is missing or expired. Use when the agent first connects to verify " +
        "the MCP transport itself is alive before reaching for any weeek_* tool.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: {
        title: "Health check",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ msg }) => {
      const reply = `pong: ${msg}`;
      return {
        content: [{ type: "text", text: reply }],
        structuredContent: { reply },
      };
    },
  );
}
