import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../server/context.js";
import { listMembers } from "../../weeek/endpoints.js";
import { WeeekError } from "../../weeek/types.js";
import { humanMessage } from "../../weeek/humanMessage.js";
import { logger } from "../../logging/logger.js";
import { applyResponseLimits } from "../_response-limits.js";

const inputShape = {};

const memberShape = z.object({
  id: z.string().describe("Stable Weeek member identifier (string, unlike most resources)"),
  email: z.string().describe("Member's email address"),
  firstName: z.string().nullable().describe("Given name (nullable)"),
  lastName: z.string().nullable().describe("Family name (nullable)"),
});

const outputShape = {
  members: z
    .array(memberShape)
    .describe("Workspace members visible to the configured Weeek account"),
  truncated: z
    .boolean()
    .describe(
      "True if the response was clipped by the server's MAX_RESPONSE_CHARS gate. " +
        "Re-issue with stricter filters or raise MAX_RESPONSE_CHARS in the server " +
        "env to receive the full member list.",
    ),
};

export function registerWeeekListMembersTool(
  server: McpServer,
  ctx: ToolContext,
): void {
  server.registerTool(
    "weeek_list_members",
    {
      title: "List Weeek workspace members",
      description:
        "PRIMARY tool for member discovery: returns every member of the " +
        "configured Weeek workspace ({id, email, firstName, lastName} per " +
        "member). DISTINCT from weeek_get_me — that returns the *caller*; " +
        "this returns *every workspace participant*. Member `id` is a " +
        "string (unlike most Weeek resources). Use when an agent needs to " +
        "resolve a name/email to a member id.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: {
        title: "List Weeek workspace members",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const members = await listMembers(ctx.weeek);
        return applyResponseLimits(
          "weeek_list_members",
          {
            content: [
              {
                type: "text",
                text: `${String(members.length)} member(s)`,
              },
            ],
            structuredContent: { members, truncated: false },
          },
          ctx.config,
        );
      } catch (err) {
        if (err instanceof WeeekError) {
          logger.warn("weeek_list_members failed", {
            code: err.code,
            status: err.status,
          });
          return {
            content: [
              {
                type: "text",
                text: `weeek_list_members failed (${err.code}): ${humanMessage(err)}`,
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
