import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../server/context.js";
import { listBoardColumns } from "../../weeek/endpoints.js";
import { WeeekError } from "../../weeek/types.js";
import { humanMessage } from "../../weeek/humanMessage.js";
import { logger } from "../../logging/logger.js";
import { applyResponseLimits } from "../_response-limits.js";

const inputShape = {
  board_id: z
    .number()
    .int()
    .positive()
    .describe(
      "Weeek board identifier (from weeek_list_boards or the Weeek UI). " +
        "Required — `/tm/board-columns` returns HTTP 422 without it.",
    ),
};

const boardColumnShape = z.object({
  id: z.number().int().describe("Stable Weeek board column identifier"),
  name: z
    .string()
    .describe(
      "Column name (Weeek uses `name`, not `title`, for board columns)",
    ),
  boardId: z.number().int().describe("Owning board id"),
});

const outputShape = {
  boardColumns: z
    .array(boardColumnShape)
    .describe(
      "Columns belonging to the requested board. Array order is the upstream " +
        "sort signal — preserved verbatim (no `position` / `sortOrder` field).",
    ),
  truncated: z
    .boolean()
    .describe(
      "True if the response was clipped by the server's MAX_RESPONSE_CHARS gate. " +
        "Re-issue with a narrower board_id or raise MAX_RESPONSE_CHARS in the " +
        "server env to receive the full payload.",
    ),
};

export function registerWeeekListBoardColumnsTool(
  server: McpServer,
  ctx: ToolContext,
): void {
  server.registerTool(
    "weeek_list_board_columns",
    {
      title: "List Weeek columns for a board",
      description:
        "PRIMARY tool for board-column discovery: returns every column of a " +
        "Weeek board ({id, name, boardId} per column) in upstream sort order " +
        "(preserved verbatim — the array order is the signal). board_id is " +
        "required. Use when the agent needs a board's column/stage layout, " +
        "e.g. to interpret a task's status or drive a board view.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: {
        title: "List Weeek columns for a board",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ board_id }) => {
      try {
        const columns = await listBoardColumns(ctx.weeek, board_id);
        return applyResponseLimits(
          "weeek_list_board_columns",
          {
            content: [
              {
                type: "text",
                text: `${String(columns.length)} column(s)`,
              },
            ],
            structuredContent: { boardColumns: columns, truncated: false },
          },
          ctx.config,
        );
      } catch (err) {
        if (err instanceof WeeekError) {
          logger.warn("weeek_list_board_columns failed", {
            code: err.code,
            status: err.status,
          });
          return {
            content: [
              {
                type: "text",
                text: `weeek_list_board_columns failed (${err.code}): ${humanMessage(err)}`,
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
