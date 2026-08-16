import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../server/context.js";
import {
  createTask,
  TASK_TYPES,
  WeeekWriteLandedError,
  type CreateTaskArgs,
} from "../../weeek/endpoints.js";
import { WeeekError } from "../../weeek/types.js";
import { applyResponseLimits } from "../_response-limits.js";
import { writeToolError } from "./_write-tool-error.js";
import {
  taskDetailOutputShape,
  taskDetailStructured,
} from "./_task-detail-output.js";

// I8 (#45) — the tool that closes the loop: an agent can file the task it just
// decided is needed, instead of describing the task a human should file.
//
// Two required inputs, seven optional ones, and **every one of the seven was
// verified against the live create endpoint** (probe #45, 2026-07-22) rather
// than read off the API docs: a Weeek write accepts an unknown field with a
// 200 and silently ignores it (the `customFields`-array trap, probe #12), so a
// documented-but-unprobed field would ship looking like it worked. Nothing was
// left out — the probe round-tripped all seven through a create + re-GET.
//
// The two requirements are OURS, not the API's. The probe showed
// `POST /tm/tasks` answering 200 to a body with no title (storing
// `title: null` — an untitled card) and to one with no project (storing
// `projectId: null` — a task in no project at all). Weeek will happily accept
// junk; this schema is the only thing standing between a confused agent and a
// blank card in someone's live workspace.
const inputShape = {
  title: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Task title — required, and required HERE rather than by Weeek: the " +
        "API accepts a create with no title and stores an untitled card. " +
        "Write the title a human would want to read on the board.",
    ),
  project_id: z
    .number()
    .int()
    .positive()
    .describe(
      "Target project, from weeek_list_projects. Required — Weeek accepts a " +
        "create without one and files the task into no project at all, where " +
        "nobody will see it.",
    ),
  description: z
    .string()
    .optional()
    .describe(
      "Task body. Plain text is fine; Weeek stores it as HTML, so the " +
        "description on the returned task may come back wrapped in markup " +
        "(a plain line comes back as '<p>…</p>'). Omit for no description.",
    ),
  type: z
    .enum(TASK_TYPES)
    .optional()
    .describe(
      "Task kind. Omit for Weeek's own default ('action'). 'meet' and " +
        "'call' mark the task as a meeting or a call.",
    ),
  priority: z
    .number()
    .int()
    .optional()
    .describe(
      "Priority code (commonly 0=Low, 1=Medium, 2=High, 3=Hold). The range " +
        "is not guaranteed by the API, so it is not enforced here. Omit to " +
        "leave the task unprioritised — that is a real state (null), not 0.",
    ),
  board_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Target board, from weeek_list_boards. Independent of " +
        "board_column_id: supplying only a board lands the task in that " +
        "board's first column. Omit both to leave the task off the boards, " +
        "in the project's task list only.",
    ),
  board_column_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Target column, from weeek_list_board_columns — a column IS a status " +
        "in Weeek, so this is where the new card starts. Independent of " +
        "board_id: a column implies the board it lives on, so supplying only " +
        "this is enough.",
    ),
  assignees: z
    .array(z.string())
    .optional()
    .describe(
      "Member UUIDs to assign, from weeek_list_members.id. The first becomes " +
        "the task's primary assignee (userId). Omit to leave the task " +
        "unassigned; do not pass an empty array to mean that.",
    ),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe(
      "Due date as YYYY-MM-DD (date only — Weeek's own format; a timestamp " +
        "is rejected). Omit for no due date.",
    ),
};

export function registerWeeekCreateTaskTool(
  server: McpServer,
  ctx: ToolContext,
): void {
  server.registerTool(
    "weeek_create_task",
    {
      title: "Create a Weeek task",
      description:
        "PRIMARY tool for filing a NEW Weeek task: pass a title and a target " +
        "project, plus any of description, type, priority, board, column, " +
        "assignees and due date. Returns the created task with its new id, so " +
        "no follow-up read is needed. A description and the assignee list can " +
        "ONLY be set here — Weeek's edit endpoint accepts both and silently " +
        "ignores them, so no tool on this server changes either later. " +
        "DISTINCT from weeek_update_task (edits an " +
        "EXISTING task) and weeek_move_task (moves one between columns and " +
        "boards); both take a task_id, which this tool has no argument for. " +
        "Use when work is identified but not yet tracked — each call files a " +
        "separate task, so never re-issue one to check whether it worked.",
      inputSchema: inputShape,
      outputSchema: taskDetailOutputShape,
      annotations: {
        title: "Create a Weeek task",
        // INVARIANT-12: mirrors `readOnly: false` in `registry.ts`.
        readOnlyHint: false,
        // Read as "mutates the live workspace, worth a human confirm" (ADR
        // 0004 §2): a spurious task in a shared board is noise a human has to
        // find and clear, and API v1 gives the agent no way to take it back.
        destructiveHint: true,
        // The sharpest non-idempotent tool in the set: a re-fire is not a
        // second write to one row, it is a second row.
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        // snake_case in, upstream camelCase out — the same seam
        // `weeek_list_tasks` has for its query parameters (INVARIANT-13).
        // Assigned key-by-key so an omitted optional stays omitted all the way
        // to the wire; `exactOptionalPropertyTypes` is what makes the
        // difference between "absent" and "present and undefined" a type
        // error rather than a runtime surprise.
        const createArgs: CreateTaskArgs = {
          title: args.title,
          projectId: args.project_id,
        };
        if (args.description !== undefined) {
          createArgs.description = args.description;
        }
        if (args.type !== undefined) createArgs.type = args.type;
        // `!== undefined`, never truthiness: priority 0 is "Low", not "unset".
        if (args.priority !== undefined) createArgs.priority = args.priority;
        if (args.board_id !== undefined) createArgs.boardId = args.board_id;
        if (args.board_column_id !== undefined) {
          createArgs.boardColumnId = args.board_column_id;
        }
        if (args.assignees !== undefined) createArgs.assignees = args.assignees;
        if (args.due_date !== undefined) createArgs.dueDate = args.due_date;

        const task = await createTask(ctx.weeek, createArgs);
        return applyResponseLimits(
          "weeek_create_task",
          {
            content: [
              {
                type: "text",
                text: `#${String(task.id)} ${task.title} — created`,
              },
            ],
            structuredContent: taskDetailStructured(task),
          },
          ctx.config,
        );
      } catch (err) {
        if (err instanceof WeeekError) {
          // A 2xx whose body we could not parse means the task EXISTS and we
          // cannot say which one it is — the new id being the one thing a
          // create is for. `humanMessage` advises retrying several of these
          // codes; here a retry files a second task, so the note overrides
          // that advice explicitly and names the read that recovers the id.
          const landedNote =
            err instanceof WeeekWriteLandedError
              ? " NOTE: the task WAS created — only the task Weeek returned" +
                " could not be read, so its new id is not included here." +
                " Do NOT re-issue this call: that would file a SECOND task." +
                " Find the one that exists with weeek_list_tasks on the same" +
                " project instead."
              : "";
          return writeToolError("weeek_create_task", err, landedNote);
        }
        throw err;
      }
    },
  );
}
