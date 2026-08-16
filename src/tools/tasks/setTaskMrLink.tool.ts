import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../server/context.js";
import {
  setTaskMrLink,
  MR_LINK_FIELD_NAMES,
  WeeekMrFieldAmbiguousError,
  WeeekMrFieldNotFoundError,
  WeeekWriteLandedError,
  type SetTaskMrLinkArgs,
} from "../../weeek/endpoints.js";
import { WeeekError } from "../../weeek/types.js";
import { applyResponseLimits } from "../_response-limits.js";
import { writeToolError } from "./_write-tool-error.js";
import {
  taskDetailOutputShape,
  taskDetailStructured,
} from "./_task-detail-output.js";

// I8 (#47) — the merge-request link. An agent that has just opened an MR can
// record it against the task that tracks it, so the tracker and the review
// stay linked without a human copy-pasting between two tabs.
//
// **One field, and no way to reach any other.** The transport is the same
// `PUT /tm/tasks/{id}` `weeek_update_task` and `weeek_move_task` write to, but
// the body key is disjoint (`customFields`), and so is this input surface: no
// title, no priority, no board. That is what makes the ADR 0004 §5
// "DISTINCT from" claim structural rather than a wording promise.
//
// **Which custom field gets written is RESOLVED, not assumed** (ADR 0005 §3):
// an explicit id skips the lookup entirely, an explicit name overrides the
// candidate list, and anything else is an error rather than a guess. The
// candidate names are published in the description below so an operator can
// name their Weeek field to match.

// One source for the names, quoted into the description and matched by the
// resolver. A prose copy would be a second list that drifts.
const CANDIDATE_NAMES = MR_LINK_FIELD_NAMES.join(", ");

const inputShape = {
  task_id: z
    .number()
    .int()
    .positive()
    .describe("Weeek task identifier (from weeek_list_tasks or the Weeek UI)"),
  mr_url: z
    .string()
    .trim()
    .url()
    .refine((v) => /^https?:\/\//i.test(v), {
      message: "must be an http(s) URL",
    })
    .describe(
      "The merge-request / pull-request URL to record on the task. Stored " +
        "verbatim as the custom field's value; re-issuing with a different " +
        "URL replaces it.",
    ),
  custom_field_id: z
    .string()
    .trim()
    .uuid()
    .optional()
    .describe(
      "UUID of the custom field to write — NOT an integer, unlike every " +
        "other id on this server. Supply it to skip the workspace " +
        "custom-fields lookup entirely (one fewer request), or to settle an " +
        "ambiguous name match. Takes precedence over custom_field_name.",
    ),
  custom_field_name: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Name of the custom field to write, matched case-insensitively. " +
        "Supply it when the workspace's MR-link field is called something " +
        "outside the default candidate list; it REPLACES that list rather " +
        "than extending it. The named field must be link- or text-typed — " +
        "those are the types that hold a plain string; use custom_field_id " +
        "to write into any other.",
    ),
};

export function registerWeeekSetTaskMrLinkTool(
  server: McpServer,
  ctx: ToolContext,
): void {
  server.registerTool(
    "weeek_set_task_mr_link",
    {
      title: "Record a merge-request link on a Weeek task",
      description:
        "PRIMARY tool for linking a Weeek task to the merge/pull request " +
        "that implements it. Writes mr_url into the workspace's MR-link " +
        "custom field and ONLY that field; the field is found by name " +
        `(${CANDIDATE_NAMES}) unless you pass custom_field_id or ` +
        "custom_field_name. DISTINCT from weeek_update_task, which edits " +
        "title, priority, type and due date and cannot write a custom " +
        "field. Use when an MR or PR has just been opened for a tracked " +
        "task.",
      inputSchema: inputShape,
      outputSchema: taskDetailOutputShape,
      annotations: {
        title: "Record a merge-request link on a Weeek task",
        // INVARIANT-12: mirrors `readOnly: false` in `registry.ts`.
        readOnlyHint: false,
        // ADR 0005 §5: a single dedicated slot set to an explicit value and
        // reversible by re-setting. Overwriting a previous link is bounded —
        // unlike the arbitrary-field edit that makes update_task
        // confirm-worthy, or a create's spurious second card.
        destructiveHint: false,
        // The call sets one field to an explicit target value, so a re-fire
        // lands the same state — the profile complete_task has.
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        // snake_case in, camelCase across the transport seam (INVARIANT-13),
        // key-by-key so an omitted optional stays omitted: `customFieldId`
        // present-but-undefined would defeat the `??` that decides whether
        // the listing request happens at all.
        const linkArgs: SetTaskMrLinkArgs = { url: args.mr_url };
        if (args.custom_field_id !== undefined) {
          linkArgs.customFieldId = args.custom_field_id;
        }
        if (args.custom_field_name !== undefined) {
          linkArgs.customFieldName = args.custom_field_name;
        }
        const task = await setTaskMrLink(ctx.weeek, args.task_id, linkArgs);
        return applyResponseLimits(
          "weeek_set_task_mr_link",
          {
            content: [
              {
                type: "text",
                text: `#${String(task.id)} ${task.title} — MR link set`,
              },
            ],
            structuredContent: taskDetailStructured(task),
          },
          ctx.config,
        );
      } catch (err) {
        if (err instanceof WeeekError) {
          return writeToolError(
            "weeek_set_task_mr_link",
            err,
            noteFor(err, args.task_id),
          );
        }
        throw err;
      }
    },
  );
}

// The three cases the shared error sentence cannot describe on its own. All
// ride the one error leg, and they are mutually exclusive by construction: a
// write refused during field resolution cannot also have landed.
//
// None of them names a custom field the workspace actually holds — the
// resolver deliberately does not carry those names out (INVARIANT-2), so what
// the agent gets is the remedy, not the listing.
function noteFor(err: WeeekError, taskId: number): string {
  // Rung 3 of the ladder (ADR 0005 §3). `humanMessage` says the request was
  // not sent; only the tool knows the request in question was the WRITE, that
  // the workspace lookup is what failed, and that a field may simply not exist
  // to write into — including because the tenant's plan does not offer them.
  if (err instanceof WeeekMrFieldNotFoundError) {
    return (
      ` No link- or text-typed custom field with an MR-link name was found in` +
      ` this workspace, so nothing was written. Name the field with` +
      ` custom_field_name, or its UUID with custom_field_id (which skips the` +
      ` lookup entirely), or ask an operator to add a link-type custom field` +
      ` called one of: ${CANDIDATE_NAMES}. Custom fields may also be` +
      ` unavailable on this workspace's Weeek plan, in which case this tool` +
      ` cannot be used at all.`
    );
  }
  // Two fields answer to the same name. Picking one by list order would be a
  // coin flip that looks exactly like a correct resolution from the outside.
  if (err instanceof WeeekMrFieldAmbiguousError) {
    return (
      ` The name matched more than one custom field, so nothing was written` +
      ` — this server does not guess between them. Re-issue with` +
      ` custom_field_id (the field's UUID) to name the one you meant.`
    );
  }
  // A 2xx whose body we could not parse means the link DID land and only the
  // resulting task could not be read. Retrying is safe here (this tool is
  // idempotent), but a read is cheaper and shows the real state.
  if (err instanceof WeeekWriteLandedError) {
    return (
      ` NOTE: the MR link WAS written — only the task Weeek returned could` +
      ` not be read, so it is not included here. Read the current state with` +
      ` weeek_get_task (task_id ${String(taskId)}).`
    );
  }
  return "";
}
