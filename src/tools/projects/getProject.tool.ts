import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../server/context.js";
import { getProject } from "../../weeek/endpoints.js";
import { WeeekError } from "../../weeek/types.js";
import { humanMessage } from "../../weeek/humanMessage.js";
import { logger } from "../../logging/logger.js";
import { applyResponseLimits } from "../_response-limits.js";

const inputShape = {
  project_id: z
    .number()
    .int()
    .positive()
    .describe("Weeek project identifier (from list_projects or the Weeek UI)"),
};

const outputShape = {
  id: z.number().int().describe("Stable Weeek project identifier"),
  title: z.string().describe("Project title"),
  description: z
    .string()
    .nullable()
    .describe(
      "Project description (nullable). May end with the marker " +
        "'…[truncated]' if the response hit MAX_RESPONSE_CHARS — " +
        "see the truncated field.",
    ),
  color: z.string().describe("Hex or named accent color"),
  isPrivate: z.boolean().describe("True if the project is private"),
  truncated: z
    .boolean()
    .describe(
      "True if the response was clipped by the server's MAX_RESPONSE_CHARS gate. " +
        "Only `description` is clipped (other fields are fixed-shape); raise " +
        "MAX_RESPONSE_CHARS in the server env to receive the full text.",
    ),
};

export function registerWeeekGetProjectTool(
  server: McpServer,
  ctx: ToolContext,
): void {
  server.registerTool(
    "weeek_get_project",
    {
      title: "Get one Weeek project",
      description:
        "PRIMARY tool for fetching a single Weeek project's full detail by id, " +
        "including description ({id, title, description, color, isPrivate}). " +
        "DISTINCT from weeek_list_projects, which returns summaries only " +
        "({id, title, color, isPrivate}) without descriptions and without " +
        "support for fetching by id. Use when you already know the project id " +
        "(from weeek_list_projects or the Weeek UI) and need the description " +
        "or want to confirm a single project still exists. Unknown ids surface " +
        "as weeek_get_project failed (weeek_not_found).",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: {
        title: "Get one Weeek project",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ project_id }) => {
      try {
        const project = await getProject(ctx.weeek, project_id);
        return applyResponseLimits(
          "weeek_get_project",
          {
            content: [
              {
                type: "text",
                text: `#${String(project.id)} ${project.title}`,
              },
            ],
            structuredContent: {
              id: project.id,
              title: project.title,
              description: project.description,
              color: project.color,
              isPrivate: project.isPrivate,
              truncated: false,
            },
          },
          ctx.config,
        );
      } catch (err) {
        if (err instanceof WeeekError) {
          logger.warn("weeek_get_project failed", {
            code: err.code,
            status: err.status,
          });
          return {
            content: [
              {
                type: "text",
                text: `weeek_get_project failed (${err.code}): ${humanMessage(err)}`,
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
