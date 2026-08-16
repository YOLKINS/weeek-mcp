import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../server/context.js";
import { listTasks, type ListTasksArgs } from "../../weeek/endpoints.js";
import { WeeekError } from "../../weeek/types.js";
import { humanMessage } from "../../weeek/humanMessage.js";
import { logger } from "../../logging/logger.js";
import { applyResponseLimits } from "../_response-limits.js";

const inputShape = {
  project_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Filter to tasks of this project"),
  board_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Filter to tasks on this board (id from weeek_list_boards). An id " +
        "that does not exist is rejected as an error, not answered with an " +
        "empty list.",
    ),
  board_column_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Filter to tasks sitting in this board column — the status filter " +
        "(id from weeek_list_board_columns). Column ids are unique across " +
        "boards, so this narrows on its own; board_id is not required " +
        "alongside it. An id that does not exist is rejected as an error, " +
        "not answered with an empty list.",
    ),
  assignee_id: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Filter to tasks this member is assigned to — matches any assignee, " +
        "not only the primary one (a task where the member is a secondary " +
        "assignee still matches). UUID from weeek_list_members.id. A UUID " +
        "that is not a member of this workspace is rejected as an error " +
        "(weeek_validation_error, HTTP 422), not answered with an empty list.",
    ),
  completed: z
    .boolean()
    .optional()
    .describe("If true, return only completed tasks; if false, only open ones"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Pagination offset (number of items to skip)"),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe(
      "Pagination page size (1-100). Default 20 — sized so a single page " +
        "fits comfortably under the 25k MCP-token cap that most clients use " +
        "for `tools/call` responses; raise explicitly if you need a larger " +
        "page and have the budget for it.",
    ),
};

const taskShape = z.object({
  id: z.number().int().describe("Stable Weeek task identifier"),
  title: z.string().describe("Task title"),
  completed: z.boolean().describe("Whether the task is completed"),
  projectId: z.number().int().describe("Owning project id"),
  priority: z
    .number()
    .int()
    .nullable()
    .describe(
      "Priority code (commonly 0=Low, 1=Medium, 2=High, 3=Hold), or null " +
        "when no priority is set. The range is not guaranteed by the API.",
    ),
  type: z.string().describe("Task type (action | meet | call)"),
  userId: z
    .string()
    .nullable()
    .describe(
      "UUID of the primary assignee (Weeek member id, matches " +
        "weeek_list_members.id). Null if the task is unassigned.",
    ),
  assignees: z
    .array(z.string())
    .describe(
      "UUIDs of every assignee on the task (matches weeek_list_members.id). " +
        "Empty if the task is unassigned; includes userId on assigned tasks.",
    ),
});

const outputShape = {
  tasks: z.array(taskShape).describe("Tasks matching the filters"),
  hasMore: z
    .boolean()
    .describe(
      "True if more tasks exist beyond this page; call again with " +
        "offset = previous offset + tasks.length",
    ),
  truncated: z
    .boolean()
    .describe(
      "True if the response was clipped by the server's MAX_RESPONSE_CHARS gate. " +
        "Independent from hasMore (pagination): truncated=true means the local " +
        "byte-budget gate fired, so re-issue with smaller per_page / narrower " +
        "filters or raise MAX_RESPONSE_CHARS in the server env.",
    ),
};

export function registerWeeekListTasksTool(
  server: McpServer,
  ctx: ToolContext,
): void {
  server.registerTool(
    "weeek_list_tasks",
    {
      title: "List Weeek tasks",
      description:
        "PRIMARY tool for task discovery and filtering: returns one page of " +
        "Weeek tasks filtered by project_id / board_id / board_column_id / " +
        "assignee_id / completed, paginated by offset+per_page (default 20, " +
        "max 100). Use the filters to locate the card a write tool is about " +
        "to act on " +
        "instead of paging a whole project. DISTINCT from weeek_get_task " +
        "— this returns task summaries (no description / details); fetch a " +
        "single full task via weeek_get_task. Use when the agent needs a " +
        "list view; follow `hasMore` for the next page.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: {
        title: "List Weeek tasks",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        // Defense-in-depth on the D3 default: the zod schema declares
        // `.default(20)` so SDK 1.29's `validateToolInput` substitutes the
        // default before reaching the handler. We re-apply it here via
        // `?? 20` so the contract is enforced on the handler side too,
        // independently of any future SDK-side change to default-handling
        // (and so the in-process tool tests, which deliberately bypass zod
        // per RETRO-21, still see the documented behaviour).
        // The tool's public input surface is snake_case (D4); the Weeek API
        // query parameters are upstream camelCase. The mapping lives here.
        const reqArgs: ListTasksArgs = { perPage: args.per_page ?? 20 };
        if (args.project_id !== undefined) reqArgs.projectId = args.project_id;
        if (args.board_id !== undefined) reqArgs.boardId = args.board_id;
        if (args.board_column_id !== undefined)
          reqArgs.boardColumnId = args.board_column_id;
        if (args.assignee_id !== undefined)
          reqArgs.assigneeId = args.assignee_id;
        if (args.completed !== undefined) reqArgs.completed = args.completed;
        if (args.offset !== undefined) reqArgs.offset = args.offset;
        const result = await listTasks(ctx.weeek, reqArgs);
        return applyResponseLimits(
          "weeek_list_tasks",
          {
            content: [
              {
                type: "text",
                text: `${String(result.tasks.length)} task(s), hasMore=${String(result.hasMore)}`,
              },
            ],
            structuredContent: {
              tasks: result.tasks,
              hasMore: result.hasMore,
              truncated: false,
            },
          },
          ctx.config,
        );
      } catch (err) {
        if (err instanceof WeeekError) {
          logger.warn("weeek_list_tasks failed", {
            code: err.code,
            status: err.status,
          });
          return {
            content: [
              {
                type: "text",
                text: `weeek_list_tasks failed (${err.code}): ${humanMessage(err)}`,
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
