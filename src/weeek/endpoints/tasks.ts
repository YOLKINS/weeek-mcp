import type { WeeekClient, WeeekRawResponse } from "../client.js";
import { parseWeeekResponse } from "../unwrap.js";
import type {
  TaskSummary,
  TaskListResponse,
  TaskDetail,
} from "../types.js";
import { shapeField, shapeList } from "../shape.js";
import { asJson, invalid } from "./shared.js";

export interface ListTasksArgs {
  projectId?: number;
  boardId?: number;
  boardColumnId?: number;
  assigneeId?: string;
  completed?: boolean;
  offset?: number;
  perPage?: number;
}

// I7.5 (#36) — the two task parsers read through `shapeField` / `shapeList`:
// no inner-field drift can throw (ADR 0003). Summary rows flow from
// `weeek_list_tasks`, the single detail from `weeek_get_task`; the warn tag
// distinguishes the two.
const LIST_ENDPOINT = "list_tasks";
const DETAIL_ENDPOINT = "get_task";

// `userId` is a nullable UUID string (probe-confirmed, I7 session B):
// absent/null → null (not drift), a present-but-wrong-typed value → null.
// `assignees` is a UUID `string[]`. A non-array collection, OR an array
// carrying any non-string element, degrades the WHOLE field to `[]` — never a
// throw, and never a placeholder `""` id: a synthetic empty-string member id
// would be as misleading as the fully-synthetic all-defaults row ADR 0003
// rejects. Routing through the array family keeps the `[]` fallback and its
// single dedup warn centralised in `shapeField`.
function readAssigneeFields(
  endpoint: string,
  obj: Record<string, unknown>,
): { userId: string | null; assignees: readonly string[] } {
  const userId = shapeField(
    { endpoint, field: "userId" },
    { kind: "nullable", of: "string", value: obj["userId"] },
  );
  const rawAssignees = obj["assignees"];
  // A clean UUID `string[]` is trustworthy; a non-array collection, or an
  // array with any non-string element, is not. An untrustworthy value is fed
  // into the array family as a non-array (`undefined`) so it degrades to `[]`
  // and fires the single dedup'd `assignees` warn — the family is here for its
  // `[]`-fallback + warn, not to shape elements (on the trustworthy path every
  // element is already a string, so `coerce` is an identity pass; on the
  // degrade path it never runs).
  const trustworthy =
    Array.isArray(rawAssignees) &&
    rawAssignees.every((a: unknown) => typeof a === "string");
  const assignees = shapeField(
    { endpoint, field: "assignees" },
    {
      kind: "array",
      value: trustworthy ? rawAssignees : undefined,
      coerce: (a) => a as string,
    },
  );
  return { userId, assignees };
}

function taskSummaryFromJson(obj: Record<string, unknown>): TaskSummary {
  const { userId, assignees } = readAssigneeFields(LIST_ENDPOINT, obj);
  return {
    id: shapeField({ endpoint: LIST_ENDPOINT, field: "id" }, { kind: "number", value: obj["id"] }),
    title: shapeField(
      { endpoint: LIST_ENDPOINT, field: "title" },
      { kind: "string", value: obj["title"] },
    ),
    // Completion is sourced from the upstream `isCompleted` field (bug #25);
    // the warn tag names `isCompleted` (the field an operator would grep
    // upstream), while the normalized output key stays `completed`.
    completed: shapeField(
      { endpoint: LIST_ENDPOINT, field: "isCompleted" },
      { kind: "boolean", value: obj["isCompleted"] },
    ),
    projectId: shapeField(
      { endpoint: LIST_ENDPOINT, field: "projectId" },
      { kind: "number", value: obj["projectId"] },
    ),
    // `priority` is `number | null` upstream (null = "no priority set"); a
    // present-but-wrong-typed value degrades to null, not to `0`.
    priority: shapeField(
      { endpoint: LIST_ENDPOINT, field: "priority" },
      { kind: "nullable", of: "number", value: obj["priority"] },
    ),
    type: shapeField(
      { endpoint: LIST_ENDPOINT, field: "type" },
      { kind: "string", value: obj["type"] },
    ),
    userId,
    assignees,
  };
}

// `endpoint` is the drift-warn tag, not a path: the same detail shape arrives
// from a read (`get_task`) and from every write echo (`move_task`, …), and an
// operator grepping a shape warn needs to know which call produced it.
function taskDetailFromJson(
  endpoint: string,
  status: number,
  raw: unknown,
): TaskDetail {
  const obj = asJson(raw);
  // The whole detail resource being a non-object stays a hard error — a detail
  // cannot "drop" the way a list entry can, and a fully-synthetic all-defaults
  // task would look successful but be garbage (ADR 0003). Individual fields
  // below still degrade.
  if (obj === undefined) throw invalid(status, "weeek task entry not an object");
  const { userId, assignees } = readAssigneeFields(endpoint, obj);
  return {
    id: shapeField({ endpoint, field: "id" }, { kind: "number", value: obj["id"] }),
    title: shapeField(
      { endpoint, field: "title" },
      { kind: "string", value: obj["title"] },
    ),
    description: shapeField(
      { endpoint, field: "description" },
      { kind: "nullable", of: "string", value: obj["description"] },
    ),
    completed: shapeField(
      { endpoint, field: "isCompleted" },
      { kind: "boolean", value: obj["isCompleted"] },
    ),
    projectId: shapeField(
      { endpoint, field: "projectId" },
      { kind: "number", value: obj["projectId"] },
    ),
    priority: shapeField(
      { endpoint, field: "priority" },
      { kind: "nullable", of: "number", value: obj["priority"] },
    ),
    type: shapeField(
      { endpoint, field: "type" },
      { kind: "string", value: obj["type"] },
    ),
    userId,
    assignees,
  };
}

export async function listTasks(
  client: WeeekClient,
  args: ListTasksArgs,
): Promise<TaskListResponse> {
  const params = new URLSearchParams();
  if (args.projectId !== undefined) params.set("projectId", String(args.projectId));
  // The two location filters (#48, live-probed 2026-07-22). Both are plain
  // integer ids and both narrow server-side: `?boardId=1` returned every task
  // on that board, `?boardColumnId=2` only the one card sitting in that
  // column, and supplying both narrowed to their intersection. Note the
  // failure mode differs from `projectId`-style filters an agent may expect:
  // an id that does not exist is a **422** (`"The selected board id is
  // invalid."`) — i.e. `weeek_validation_error` — not an empty page. A column
  // id is workspace-unique, so `boardColumnId` alone is already precise; the
  // pair is accepted for the caller that has both at hand.
  if (args.boardId !== undefined) params.set("boardId", String(args.boardId));
  if (args.boardColumnId !== undefined)
    params.set("boardColumnId", String(args.boardColumnId));
  // The assignee filter (#48). The field is named for what a caller means —
  // "tasks assigned to this person" — and the upstream parameter it maps to is
  // `userId`, the same UUID a task carries as its primary-assignee field and
  // that `weeek_list_members` returns as `id`. Naming the mapping here rather
  // than at the input surface follows the `completed` → `1`/`0` precedent
  // above. Probe-confirmed 2026-07-22: the filter narrows (an unassigned task
  // is excluded from `?userId=<member>`), and a UUID that is not a member of
  // the workspace is a 422 (`"The selected user id is invalid."`) rather than
  // an empty page — the same failure mode as the two board filters.
  if (args.assigneeId !== undefined) params.set("userId", args.assigneeId);
  // Weeek validates `completed` as a Laravel boolean: it accepts `1`/`0` and
  // rejects the JS `String(bool)` form (`true`/`false`) with HTTP 422
  // ("The completed field must be true or false."). Serialize to `1`/`0` so
  // the filter actually narrows server-side (bug #25 / #28, live-probed
  // 2026-07-21). The param name `completed` is correct — `isCompleted`, the
  // response-body field name, is silently ignored as a query filter.
  if (args.completed !== undefined) params.set("completed", args.completed ? "1" : "0");
  if (args.offset !== undefined) params.set("offset", String(args.offset));
  if (args.perPage !== undefined) params.set("perPage", String(args.perPage));
  const qs = params.toString();
  const path = qs.length > 0 ? `/tm/tasks?${qs}` : "/tm/tasks";

  const raw = await client.request({ method: "GET", path });
  const tasksRaw = parseWeeekResponse<unknown>(raw.status, raw.body, "tasks");
  // A present-but-non-array `tasks`, or a non-object entry, degrades to `[]` /
  // a dropped row rather than throwing (the envelope already proved `tasks`).
  const tasks = shapeList({ endpoint: LIST_ENDPOINT }, tasksRaw, taskSummaryFromJson);
  // hasMore is a sibling key on the envelope; success was already validated
  // by parseWeeekResponse on the line above.
  const envelope = asJson(raw.body) ?? {};
  const hasMore = envelope["hasMore"] === true;
  return { tasks, hasMore };
}

// Unwrap a `{success:true, task:{…}}` envelope into a `TaskDetail`. Shared by
// the read and by the write echoes (`endpoints/tasksWrite.ts`) so a task looks
// the same however it arrived — the promise every write tool makes when it
// says it returns what `weeek_get_task` returns.
export function parseTaskDetailResponse(
  endpoint: string,
  raw: WeeekRawResponse,
): TaskDetail {
  const task = parseWeeekResponse<unknown>(raw.status, raw.body, "task");
  return taskDetailFromJson(endpoint, raw.status, task);
}

export async function getTask(
  client: WeeekClient,
  id: number,
): Promise<TaskDetail> {
  const raw = await client.request({
    method: "GET",
    path: `/tm/tasks/${String(id)}`,
  });
  return parseTaskDetailResponse(DETAIL_ENDPOINT, raw);
}
