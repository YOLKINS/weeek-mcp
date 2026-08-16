import { z } from "zod";
import type { TaskDetail } from "../../weeek/types.js";

// The single task-detail output surface, shared by `weeek_get_task` and every
// write tool. I8 (#43) lifted it out of `getTask.tool.ts` verbatim: the write
// tools return the resulting task in *the same shape a read returns*, and the
// only way that promise survives five more tools is for there to be one copy.
// A drift here is caught twice — by the outputSchema freeze snapshot on the
// read side, and by the write tools' own schema assertions.
//
// Output field names deliberately keep the upstream Weeek spelling
// (`projectId`, `userId`) even though tool *inputs* are snake_case
// (INVARIANT-13): an agent correlates these against the API's own responses.
export const taskDetailOutputShape = {
  id: z.number().int().describe("Stable Weeek task identifier"),
  title: z.string().describe("Task title"),
  description: z
    .string()
    .nullable()
    .describe(
      "Task description (nullable). May end with the marker " +
        "'…[truncated]' if the response hit MAX_RESPONSE_CHARS — " +
        "see the truncated field.",
    ),
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
  truncated: z
    .boolean()
    .describe(
      "True if the response was clipped by the server's MAX_RESPONSE_CHARS gate. " +
        "Only `description` is clipped (other fields are fixed-shape); the agent " +
        "can re-issue with raised MAX_RESPONSE_CHARS in the server env to see the " +
        "full text.",
    ),
};

// Derived from the shape above rather than hand-written: a second copy of the
// field list is a copy that can drift from the schema the SDK validates
// against.
export type TaskDetailStructured = z.infer<
  z.ZodObject<typeof taskDetailOutputShape>
>;

// `truncated: false` is the pre-gate value; `applyResponseLimits` flips it
// when the byte budget actually fires. `assignees` is copied, not aliased —
// `TaskDetail` hands out a `readonly` array and the payload leaving here is
// the tool's own.
export function taskDetailStructured(task: TaskDetail): TaskDetailStructured {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    completed: task.completed,
    projectId: task.projectId,
    priority: task.priority,
    type: task.type,
    userId: task.userId,
    assignees: [...task.assignees],
    truncated: false,
  };
}
