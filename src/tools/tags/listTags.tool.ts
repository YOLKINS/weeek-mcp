import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../server/context.js";
import { listTags } from "../../weeek/endpoints.js";
import { WeeekError } from "../../weeek/types.js";
import { humanMessage } from "../../weeek/humanMessage.js";
import { logger } from "../../logging/logger.js";
import { applyResponseLimits } from "../_response-limits.js";

const inputShape = {};

const tagShape = z.object({
  id: z.number().int().describe("Stable Weeek tag identifier"),
  title: z.string().describe("Tag title"),
  color: z.string().describe("Tag color (hex or named)"),
});

const outputShape = {
  tags: z.array(tagShape).describe("All tags defined in the workspace"),
  truncated: z
    .boolean()
    .describe(
      "True if the response was clipped by the server's MAX_RESPONSE_CHARS gate. " +
        "Re-issue with stricter filters or raise MAX_RESPONSE_CHARS in the server " +
        "env to receive the full tag list.",
    ),
};

export function registerWeeekListTagsTool(
  server: McpServer,
  ctx: ToolContext,
): void {
  server.registerTool(
    "weeek_list_tags",
    {
      title: "List Weeek tags",
      description:
        "PRIMARY tool for tag discovery: returns every tag defined in the " +
        "configured Weeek workspace ({id, title, color} per tag). No " +
        "pagination. Use when an agent needs to map a user-supplied tag " +
        "name to a stable tag id (Weeek tasks reference tags by id).",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: {
        title: "List Weeek tags",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const tags = await listTags(ctx.weeek);
        return applyResponseLimits(
          "weeek_list_tags",
          {
            content: [{ type: "text", text: `${String(tags.length)} tag(s)` }],
            structuredContent: { tags, truncated: false },
          },
          ctx.config,
        );
      } catch (err) {
        if (err instanceof WeeekError) {
          logger.warn("weeek_list_tags failed", {
            code: err.code,
            status: err.status,
          });
          return {
            content: [
              {
                type: "text",
                text: `weeek_list_tags failed (${err.code}): ${humanMessage(err)}`,
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
