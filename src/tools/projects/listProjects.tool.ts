import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../server/context.js";
import { listProjects } from "../../weeek/endpoints.js";
import { WeeekError } from "../../weeek/types.js";
import { humanMessage } from "../../weeek/humanMessage.js";
import { logger } from "../../logging/logger.js";
import { applyResponseLimits } from "../_response-limits.js";

const inputShape = {};

const projectShape = z.object({
  id: z.number().int().describe("Stable Weeek project identifier"),
  title: z.string().describe("Project title"),
  color: z.string().describe("Hex or named accent color"),
  isPrivate: z.boolean().describe("True if the project is private"),
});

const outputShape = {
  projects: z
    .array(projectShape)
    .describe("All projects visible to the configured Weeek account"),
  truncated: z
    .boolean()
    .describe(
      "True if the response was clipped by the server's MAX_RESPONSE_CHARS gate. " +
        "Re-issue with stricter filters (smaller per_page, narrower project_id) " +
        "or raise MAX_RESPONSE_CHARS in the server env to receive the full payload.",
    ),
};

export function registerWeeekListProjectsTool(
  server: McpServer,
  ctx: ToolContext,
): void {
  server.registerTool(
    "weeek_list_projects",
    {
      title: "List Weeek projects",
      description:
        "PRIMARY tool for project discovery: returns every Weeek project " +
        "visible to the configured token ({id, title, color, isPrivate} per " +
        "project). No filters; pagination is not exposed by this endpoint. " +
        "Use when the agent needs a project_id to feed into weeek_list_tasks " +
        "or to surface the project picker to the user.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: {
        title: "List Weeek projects",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const projects = await listProjects(ctx.weeek);
        return applyResponseLimits(
          "weeek_list_projects",
          {
            content: [
              { type: "text", text: `${String(projects.length)} project(s)` },
            ],
            structuredContent: { projects, truncated: false },
          },
          ctx.config,
        );
      } catch (err) {
        if (err instanceof WeeekError) {
          logger.warn("weeek_list_projects failed", {
            code: err.code,
            status: err.status,
          });
          return {
            content: [
              {
                type: "text",
                text: `weeek_list_projects failed (${err.code}): ${humanMessage(err)}`,
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
