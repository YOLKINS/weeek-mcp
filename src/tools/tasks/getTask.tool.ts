import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../server/context.js";
import { getTask } from "../../weeek/endpoints.js";
import { WeeekError } from "../../weeek/types.js";
import { humanMessage } from "../../weeek/humanMessage.js";
import { logger } from "../../logging/logger.js";
import { applyResponseLimits } from "../_response-limits.js";
import {
  taskDetailOutputShape,
  taskDetailStructured,
} from "./_task-detail-output.js";

const inputShape = {
  task_id: z
    .number()
    .int()
    .positive()
    .describe("Weeek task identifier (from weeek_list_tasks or the Weeek UI)"),
};

export function registerWeeekGetTaskTool(
  server: McpServer,
  ctx: ToolContext,
): void {
  server.registerTool(
    "weeek_get_task",
    {
      title: "Get one Weeek task",
      description:
        "PRIMARY tool for fetching a single Weeek task by task_id ({id, title, " +
        "description, completed, projectId, priority, type}). DISTINCT from " +
        "weeek_list_tasks — this is the only tool that returns the full " +
        "`description` field. Use when an agent already has a specific id " +
        "and needs full details; unknown ids surface as " +
        "`weeek_get_task failed (weeek_not_found): …`.",
      inputSchema: inputShape,
      outputSchema: taskDetailOutputShape,
      annotations: {
        title: "Get one Weeek task",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ task_id }) => {
      try {
        const task = await getTask(ctx.weeek, task_id);
        return applyResponseLimits(
          "weeek_get_task",
          {
            content: [
              {
                type: "text",
                text: `#${String(task.id)} ${task.title}`,
              },
            ],
            structuredContent: taskDetailStructured(task),
          },
          ctx.config,
        );
      } catch (err) {
        if (err instanceof WeeekError) {
          logger.warn("weeek_get_task failed", {
            code: err.code,
            status: err.status,
          });
          return {
            content: [
              {
                type: "text",
                text: `weeek_get_task failed (${err.code}): ${humanMessage(err)}`,
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
