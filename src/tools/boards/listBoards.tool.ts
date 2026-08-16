import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../server/context.js";
import { listBoards } from "../../weeek/endpoints.js";
import { WeeekError } from "../../weeek/types.js";
import { humanMessage } from "../../weeek/humanMessage.js";
import { logger } from "../../logging/logger.js";
import { applyResponseLimits } from "../_response-limits.js";

const inputShape = {
  project_id: z
    .number()
    .int()
    .positive()
    .describe(
      "Weeek project identifier (from weeek_list_projects or the Weeek UI). " +
        "Required — `/tm/boards` returns HTTP 422 without it.",
    ),
};

const boardShape = z.object({
  id: z.number().int().describe("Stable Weeek board identifier"),
  name: z
    .string()
    .describe("Board name (Weeek uses `name`, not `title`, for boards)"),
  projectId: z.number().int().describe("Owning project id"),
  isPrivate: z.boolean().describe("True if the board is private"),
});

const outputShape = {
  boards: z
    .array(boardShape)
    .describe("Boards belonging to the requested project"),
  truncated: z
    .boolean()
    .describe(
      "True if the response was clipped by the server's MAX_RESPONSE_CHARS gate. " +
        "Re-issue with a narrower project_id or raise MAX_RESPONSE_CHARS in the " +
        "server env to receive the full payload.",
    ),
};

export function registerWeeekListBoardsTool(
  server: McpServer,
  ctx: ToolContext,
): void {
  server.registerTool(
    "weeek_list_boards",
    {
      title: "List Weeek boards for a project",
      description:
        "PRIMARY tool for board discovery within a project: returns every " +
        "Weeek board in the given project ({id, name, projectId, isPrivate} " +
        "per board). project_id is required; pagination is not exposed by this " +
        "endpoint. Use when the agent needs a board_id to feed into " +
        "weeek_list_board_columns, or to surface the board picker for a project.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: {
        title: "List Weeek boards for a project",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ project_id }) => {
      try {
        const boards = await listBoards(ctx.weeek, project_id);
        return applyResponseLimits(
          "weeek_list_boards",
          {
            content: [
              {
                type: "text",
                text: `${String(boards.length)} board(s)`,
              },
            ],
            structuredContent: { boards, truncated: false },
          },
          ctx.config,
        );
      } catch (err) {
        if (err instanceof WeeekError) {
          logger.warn("weeek_list_boards failed", {
            code: err.code,
            status: err.status,
          });
          return {
            content: [
              {
                type: "text",
                text: `weeek_list_boards failed (${err.code}): ${humanMessage(err)}`,
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
