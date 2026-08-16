import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../server/context.js";
import { getMe } from "../../weeek/endpoints.js";
import { WeeekError } from "../../weeek/types.js";
import { humanMessage } from "../../weeek/humanMessage.js";
import { logger } from "../../logging/logger.js";

const inputShape = {};

const outputShape = {
  id: z
    .union([z.number(), z.string()])
    .describe("Stable Weeek user identifier"),
  email: z.string().describe("Email address of the authenticated Weeek user"),
  name: z.string().describe("Display name of the authenticated Weeek user"),
};

export function registerWeeekGetMeTool(
  server: McpServer,
  ctx: ToolContext,
): void {
  server.registerTool(
    "weeek_get_me",
    {
      title: "Current Weeek user",
      description:
        "PRIMARY tool for confirming WEEEK_ACCESS_TOKEN works against the " +
        "live API. Returns {id, email, name} for the Weeek account that owns " +
        "the configured token. DISTINCT from ping (which never reaches the " +
        "network) — a successful weeek_get_me proves both transport AND " +
        "credentials. Use when an agent is about to run weeek_list_* / " +
        "weeek_get_* and wants a one-shot token sanity-check first.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: {
        title: "Current Weeek user",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        // Differs from ping: this tool reaches out to api.weeek.net.
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const me = await getMe(ctx.weeek);
        return {
          content: [{ type: "text", text: `${me.name} <${me.email}>` }],
          structuredContent: { id: me.id, email: me.email, name: me.name },
        };
      } catch (err) {
        if (err instanceof WeeekError) {
          // Tool-level error per MCP 2025-06-18: return `isError: true`
          // instead of throwing McpError, so the model can react. Log code +
          // status only; never the response body or token.
          logger.warn("weeek_get_me failed", {
            code: err.code,
            status: err.status,
          });
          return {
            content: [
              {
                type: "text",
                text: `weeek_get_me failed (${err.code}): ${humanMessage(err)}`,
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
    },
  );
}
