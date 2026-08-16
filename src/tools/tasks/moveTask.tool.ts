import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../server/context.js";
import {
  moveTask,
  WeeekWriteLandedError,
  type MoveTaskArgs,
} from "../../weeek/endpoints.js";
import { WeeekError } from "../../weeek/types.js";
import { applyResponseLimits } from "../_response-limits.js";
import { writeToolError } from "./_write-tool-error.js";
import {
  taskDetailOutputShape,
  taskDetailStructured,
} from "./_task-detail-output.js";

// I8 (#44) — the status-change tool. Its input surface carries no title, no
// priority and no completion flag, so the two mutations an agent most easily
// confuses this with cannot be expressed here at all (ADR 0004 §5).
//
// `board_column_id` is required and `board_id` is not, which makes the two
// modes exactly expressible and nothing else: a column alone is a same-board
// move; a board with a column is a cross-board re-parent; a board WITHOUT a
// column — "move it over there, you pick where it lands" — is not in the
// schema, by design.
const inputShape = {
  task_id: z
    .number()
    .int()
    .positive()
    .describe("Weeek task identifier (from weeek_list_tasks or the Weeek UI)"),
  board_column_id: z
    .number()
    .int()
    .positive()
    .describe(
      "Target column, from weeek_list_board_columns. Required — a column is " +
        "what a status IS in Weeek, so a move without one has no meaning. " +
        "When moving across boards this must be a column that lives on the " +
        "destination board.",
    ),
  board_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Target board, from weeek_list_boards. Omit for a move within the " +
        "task's current board (the common case). Supply it only to " +
        "re-parent the task onto another board, alongside a board_column_id " +
        "belonging to that board.",
    ),
};

export function registerWeeekMoveTaskTool(
  server: McpServer,
  ctx: ToolContext,
): void {
  server.registerTool(
    "weeek_move_task",
    {
      title: "Move a Weeek task to another column or board",
      description:
        "PRIMARY tool for changing a Weeek task's status: a board column IS a " +
        "status in Weeek, so 'move the card to Done' and 'set this task to " +
        "In Progress' are both this tool. Pass board_id as well to re-parent " +
        "the task onto a different board. DISTINCT from weeek_update_task " +
        "(edits fields: title, priority, type, due date) and DISTINCT from " +
        "weeek_complete_task (flips the separate completion flag — a task in " +
        "a Done column is not automatically marked completed). Use when work " +
        "has progressed and the card should advance.",
      inputSchema: inputShape,
      outputSchema: taskDetailOutputShape,
      annotations: {
        title: "Move a Weeek task to another column or board",
        // INVARIANT-12: mirrors `readOnly: false` in `registry.ts`.
        readOnlyHint: false,
        // Read as "mutates the live workspace, worth a human confirm" (ADR
        // 0004 §2): re-parenting the wrong card is not something the agent
        // can quietly undo, since it cannot know where the card came from.
        destructiveHint: true,
        // No target state to converge on: a second move is a second mutation.
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        // snake_case in, upstream camelCase out — the same seam
        // `weeek_list_tasks` has for its query parameters (INVARIANT-13).
        const moveArgs: MoveTaskArgs = {
          boardColumnId: args.board_column_id,
        };
        if (args.board_id !== undefined) moveArgs.boardId = args.board_id;
        const task = await moveTask(ctx.weeek, args.task_id, moveArgs);
        return applyResponseLimits(
          "weeek_move_task",
          {
            content: [
              {
                type: "text",
                text: `#${String(task.id)} ${task.title} — moved`,
              },
            ],
            structuredContent: taskDetailStructured(task),
          },
          ctx.config,
        );
      } catch (err) {
        if (err instanceof WeeekError) {
          // A 2xx whose body we could not parse means the move DID land and we
          // cannot show the result. `humanMessage` for those codes advises
          // retrying — sound advice for a read, actively wrong here, because a
          // second move is a second mutation (`idempotentHint: false`).
          const landedNote =
            err instanceof WeeekWriteLandedError
              ? " NOTE: the move itself was applied — only the task Weeek" +
                " returned could not be read, so it is not included here." +
                " Do NOT re-issue this call to recover it; read the task with" +
                " weeek_get_task instead."
              : "";
          return writeToolError("weeek_move_task", err, landedNote);
        }
        throw err;
      }
    },
  );
}
