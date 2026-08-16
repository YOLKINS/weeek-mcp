import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../server/context.js";
import { completeTask, WeeekWriteLandedError } from "../../weeek/endpoints.js";
import { WeeekError } from "../../weeek/types.js";
import { applyResponseLimits } from "../_response-limits.js";
import { writeToolError } from "./_write-tool-error.js";
import {
  taskDetailOutputShape,
  taskDetailStructured,
} from "./_task-detail-output.js";

// I8 (#43) — the FIRST mutating tool. Its registry entry is the first
// `readOnly: false`, which is what makes INVARIANT-12 real: the gate flag and
// `annotations.readOnlyHint` below must stay exact negations (ADR 0004 §3).
//
// The input surface is deliberately only the toggle. An agent that wants to
// edit a field, or to advance the card to the next column, finds no argument
// for it here and has to go looking for the tool that owns that mutation —
// a stronger signal than a description it may not have read (ADR 0004 §5).
const inputShape = {
  task_id: z
    .number()
    .int()
    .positive()
    .describe("Weeek task identifier (from weeek_list_tasks or the Weeek UI)"),
  completed: z
    .boolean()
    .default(true)
    .describe(
      "Target completion state. Omit or pass true to mark the task done; " +
        "pass false to re-open a completed task. Re-sending the same value " +
        "is a no-op, not a second mutation.",
    ),
};

export function registerWeeekCompleteTaskTool(
  server: McpServer,
  ctx: ToolContext,
): void {
  server.registerTool(
    "weeek_complete_task",
    {
      title: "Complete (or re-open) a Weeek task",
      description:
        "PRIMARY tool for flipping a Weeek task's completion flag: completed " +
        "true (the default) marks it done, false re-opens it. Writes that one " +
        "flag and nothing else, and returns the resulting task. DISTINCT from " +
        "weeek_update_task (edits fields: title, priority, type, due date) and " +
        "DISTINCT from weeek_move_task (changes the board column — a column " +
        "IS a status in Weeek, so 'move the card to Done' is that tool). Use " +
        "when the work itself is finished, or turned out not to be.",
      inputSchema: inputShape,
      outputSchema: taskDetailOutputShape,
      annotations: {
        title: "Complete (or re-open) a Weeek task",
        // INVARIANT-12: mirrors `readOnly: false` in `registry.ts`.
        readOnlyHint: false,
        // A reversible status toggle — re-sending the opposite value restores
        // the previous state — not a shape change worth a destructive confirm.
        destructiveHint: false,
        // The target state is explicit, so a re-fire lands the same state.
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        // Defence-in-depth on the schema default, same idiom as
        // `weeek_list_tasks`' `per_page`: SDK 1.29 substitutes `.default(true)`
        // before the handler runs, and we re-apply it here so the documented
        // behaviour holds independently of SDK default-handling — and so the
        // in-process tool tests, which bypass zod per RETRO-21, see it too.
        const target = args.completed ?? true;
        const task = await completeTask(ctx.weeek, args.task_id, target);
        return applyResponseLimits(
          "weeek_complete_task",
          {
            content: [
              {
                type: "text",
                text: `#${String(task.id)} ${task.title} — ${
                  task.completed ? "completed" : "not completed"
                }`,
              },
            ],
            structuredContent: taskDetailStructured(task),
          },
          ctx.config,
        );
      } catch (err) {
        if (err instanceof WeeekError) {
          // The write is two legs (mutation, then a read-back for the task to
          // return). If the second one failed, saying only "this call failed"
          // would leave the agent guessing whether the flag moved — and it
          // did.
          const readBackNote =
            err instanceof WeeekWriteLandedError
              ? " The completion itself was applied — only the follow-up read" +
                " of the task failed, so the task is not included here." +
                " Re-issuing this call is safe; it sets an explicit target" +
                " state."
              : "";
          return writeToolError("weeek_complete_task", err, readBackNote);
        }
        throw err;
      }
    },
  );
}
