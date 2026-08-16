import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../server/context.js";
import {
  updateTask,
  TASK_TYPES,
  WeeekEmptyUpdateError,
  WeeekWriteLandedError,
  type UpdateTaskArgs,
} from "../../weeek/endpoints.js";
import { WeeekError } from "../../weeek/types.js";
import { applyResponseLimits } from "../_response-limits.js";
import { writeToolError } from "./_write-tool-error.js";
import {
  taskDetailOutputShape,
  taskDetailStructured,
} from "./_task-detail-output.js";

// I8 (#46) — the field-edit tool: correct or enrich a task that already
// exists, instead of filing a second one that says the same thing better.
//
// **The input surface is deliberately disjoint from its neighbours'.** No
// board, no column (that is `weeek_move_task`), no completion flag (that is
// `weeek_complete_task`), no custom field (that is `weeek_set_task_mr_link`),
// no project. An agent reaching for "update the task's column" finds no such
// argument and must go find the tool that has one — a structural guarantee,
// where description wording is only a hint. It costs nothing: the three write
// tools already share the `PUT /tm/tasks/{id}` transport, so one endpoint
// serving several deliberately-narrow tools is the arrangement, not an
// accident of it.
//
// **The field list is shorter than it looks like it should be**, and this is
// the finding of probe #46 (2026-07-22) rather than an omission:
// `description` and `assignees` are BOTH accepted by `PUT` with a 200 and
// silently ignored. Offering them would ship a tool that reports success for
// an edit that never happened — the `customFields`-array trap (probe #12)
// repeating itself. See `docs/weeek-api-notes.md` § update for the full table
// and the alternatives that were tried.
//
// I9 (#63) put that fact in the tool's DESCRIPTION as well, which is the only
// one of its three homes an agent reads: this comment is for a developer and
// the README section is for an operator, and an agent that finds no
// `assignees` argument cannot tell "wrong tool" from "wrong argument name"
// from "the API will not do this" — so it guesses. The wording is pinned by
// `tests/invariants/mcp.test.ts` alongside the ADR 0004 §5 steering, and
// `weeek_create_task` carries the other half (the limit belongs on the tool
// that CAN set the fields as much as on the one that cannot).
//
// The two absences are NOT the same kind of limit, and the wording keeps them
// apart the way the README section does: a description has no edit route at
// all, so the UI is genuinely the only recourse; assignees DO have one
// (`POST`/`DELETE /tm/tasks/{id}/assignees`, probe #46), whose semantics are
// add/remove rather than set — this server does not expose it yet, which
// makes that half our omission and not Weeek's. Saying "reassignment is
// impossible" would be the false claim a competitor already ships.
//
// **Two fields are nullable, two are not**, and the split is the API's, not a
// style choice (probe #46f): `null` genuinely clears `priority` and `due_date`,
// so without it an agent could set a due date and never take it back off. A
// null `title` is accepted upstream and BLANKS the card, and a null `type` is
// ignored outright — neither has an "unset" state worth exposing, so allowing
// null there would only offer an agent a way to be misunderstood.
// Split from `task_id` on purpose: these are the fields an update may CHANGE,
// and "at least one of them" is the tool's central precondition. Deriving the
// names from this object means the error that lists them cannot drift from the
// schema that accepts them — and it does not have to know which key identifies
// the task in order to leave it out.
const editableShape = {
  title: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "New task title. Non-empty — Weeek accepts an empty title on an edit " +
        "and stores it as null, blanking the card, so this schema rejects it " +
        "instead. Omit to leave the title unchanged.",
    ),
  priority: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe(
      "New priority code (commonly 0=Low, 1=Medium, 2=High, 3=Hold). The " +
        "range is not guaranteed by the API, so it is not enforced here. " +
        "Pass null to REMOVE the priority, leaving the task unprioritised — " +
        "which is a real state, distinct from 0 (Low). Omit to leave the " +
        "priority unchanged.",
    ),
  type: z
    .enum(TASK_TYPES)
    .optional()
    .describe(
      "New task kind: 'action', or 'meet' / 'call' to mark it a meeting or " +
        "a call. Omit to leave the type unchanged.",
    ),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional()
    .describe(
      "New due date as YYYY-MM-DD (date only — Weeek's own format; a " +
        "timestamp is rejected). Pass null to REMOVE the due date. Omit to " +
        "leave it unchanged.",
    ),
};

const inputShape = {
  task_id: z
    .number()
    .int()
    .positive()
    .describe("Weeek task identifier (from weeek_list_tasks or the Weeek UI)"),
  ...editableShape,
};

// The agent is being told which arguments would have made its call valid, so
// the list has to be the schema's own, not a prose copy of it that can drift.
const EDITABLE_FIELDS = Object.keys(editableShape).join(", ");

export function registerWeeekUpdateTaskTool(
  server: McpServer,
  ctx: ToolContext,
): void {
  server.registerTool(
    "weeek_update_task",
    {
      title: "Update a Weeek task's fields",
      description:
        "PRIMARY tool for editing an EXISTING Weeek task: name the task_id " +
        "and any of title, priority, type and due_date. Only the fields you " +
        "name change; the rest are left alone. At least one is required, and " +
        "null on priority or due_date REMOVES that value. " +
        "DISTINCT from weeek_move_task (column and board changes — a column " +
        "IS the status in Weeek) and DISTINCT from weeek_complete_task (the " +
        "completion flag); neither is expressible here. Weeek's edit endpoint " +
        "takes a description or an assignee list and silently IGNORES both, " +
        "so this tool offers neither: both are set when the task is filed " +
        "(weeek_create_task). Afterwards a description changes only in " +
        "Weeek's UI; assignees there, or on an add/remove route this server " +
        "does not expose. Use when a task exists but says the wrong thing.",
      inputSchema: inputShape,
      outputSchema: taskDetailOutputShape,
      annotations: {
        title: "Update a Weeek task's fields",
        // INVARIANT-12: mirrors `readOnly: false` in `registry.ts`.
        readOnlyHint: false,
        // Read as "mutates the live workspace, worth a human confirm" (ADR
        // 0004 §2): an overwritten title is gone — the agent never saw the
        // old value, so it cannot put it back.
        destructiveHint: true,
        // ADR 0004 §2 pins this false for the edit tools. A re-fire with the
        // same arguments does converge, but the agent should not be invited
        // to blind-retry a write whose previous outcome it could not read.
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        // snake_case in, upstream camelCase out — the same seam
        // `weeek_list_tasks` has for its query parameters (INVARIANT-13).
        // Assigned key-by-key so an omitted field stays omitted all the way
        // to the wire: that is what makes "an edit never clobbers a field the
        // agent did not mention" true, rather than merely intended.
        const updateArgs: UpdateTaskArgs = {};
        if (args.title !== undefined) updateArgs.title = args.title;
        // `!== undefined`, never truthiness: priority 0 is "Low", not "unset".
        if (args.priority !== undefined) updateArgs.priority = args.priority;
        if (args.type !== undefined) updateArgs.type = args.type;
        if (args.due_date !== undefined) updateArgs.dueDate = args.due_date;

        const task = await updateTask(ctx.weeek, args.task_id, updateArgs);
        return applyResponseLimits(
          "weeek_update_task",
          {
            content: [
              {
                type: "text",
                text: `#${String(task.id)} ${task.title} — updated`,
              },
            ],
            structuredContent: taskDetailStructured(task),
          },
          ctx.config,
        );
      } catch (err) {
        if (err instanceof WeeekError) {
          return writeToolError(
            "weeek_update_task",
            err,
            noteFor(err, args.task_id),
          );
        }
        throw err;
      }
    },
  );
}

// The two cases where the shared error sentence is not the whole story. Both
// ride the one error leg, and they are mutually exclusive by construction: an
// update that was refused before any request cannot also have landed.
function noteFor(err: WeeekError, taskId: number): string {
  // `humanMessage` already says the request was not sent; what it cannot say
  // is WHICH arguments this particular tool would have accepted. An agent told
  // only "invalid" tends to retry the same empty call.
  if (err instanceof WeeekEmptyUpdateError) {
    return (
      ` This call named no field to change: name at least one of` +
      ` ${EDITABLE_FIELDS}.`
    );
  }
  // A 2xx whose body we could not parse means the edit DID land and only the
  // resulting task could not be read. `humanMessage` advises retrying several
  // of these codes; here the state is already changed, so point at the read
  // that shows it instead.
  if (err instanceof WeeekWriteLandedError) {
    return (
      ` NOTE: the edit WAS applied — only the task Weeek returned could not` +
      ` be read, so it is not included here. Read the current state with` +
      ` weeek_get_task (task_id ${String(taskId)}) rather than re-issuing` +
      ` this call.`
    );
  }
  return "";
}
