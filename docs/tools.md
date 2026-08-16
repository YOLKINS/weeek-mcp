# Tool reference

The field-level reference for every `weeek-mcp` tool: inputs, outputs,
truncation, multi-assignee semantics, and the edge cases an agent hits in
practice. The [README](../README.md) carries the compact tables; this file is
the depth behind them.

A default install (`READ_ONLY=true`) exposes the **ten read tools**. Setting
`READ_ONLY=false` adds the **five write tools**, taking `tools/list` to
fifteen — see [Enabling write tools](../README.md#enabling-write-tools) first.

## Input / output conventions

- Every tool **input** is snake_case (`project_id`, `task_id`, `board_id`,
  `per_page`); camelCase arguments are rejected by validation.
- Every **output** field keeps the upstream Weeek spelling (`projectId`,
  `hasMore`, `boardId`) so it correlates directly with the Weeek API.

The two conventions meet in the `weeek_list_tasks` handler, which maps
`project_id` / `per_page` onto the upstream `projectId` / `perPage` query
parameters.

Every tool carries all four `annotations` (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`) and an `outputSchema`, so clients receive
`structuredContent`. All Weeek tools (`weeek_*`) are `openWorldHint: true`
(they reach `api.weeek.net`); upstream failures surface as `isError: true`
with a stable `weeek_<code>` text and never as MCP protocol errors.

## Read tools

- `ping { msg: string } → { reply: "pong: <msg>" }` — health check, no API
  call and no token required (`openWorldHint: false`).
- `weeek_get_me {} → { id, email, name }` — calls Weeek `/user/me` to confirm
  the configured token. `name` is derived from `firstName + lastName` and falls
  back to `email` when both name parts are absent.
- `weeek_list_projects {} → { projects: [{ id, title, color, isPrivate }], truncated }` —
  every project visible to the token.
- `weeek_get_project { project_id } → { id, title, description, color, isPrivate, truncated }` —
  a single project by id, including its `description` (the list variant
  omits it). Unknown ids surface as `weeek_get_project failed
  (weeek_not_found)`. When the response exceeds `MAX_RESPONSE_CHARS`, the
  server clips `description` and appends a `…[truncated]` marker.
- `weeek_list_tasks { project_id?, board_id?, board_column_id?, assignee_id?, completed?, offset?, per_page? (default 20) } → { tasks: [{ id, title, completed, projectId, priority, type, userId, assignees }, …], hasMore, truncated }` —
  one page of tasks with offset/per_page pagination; follow `hasMore`.
  The filters are deliberately bounded — project, board, board column,
  assignee and completion, enough to locate the card a write tool is about
  to act on without paging a whole project. `board_id` / `board_column_id`
  map onto the upstream `boardId` / `boardColumnId` query parameters;
  column ids are unique across boards, so `board_column_id` narrows on its
  own. `assignee_id` (a member UUID from `weeek_list_members.id`) maps onto
  the upstream `userId` parameter and matches **any** assignee, not only
  the primary one — a task where the member is a secondary assignee still
  matches. An id that does not exist is an error
  (`weeek_validation_error`), **not** an empty page.
  `per_page` defaults to `20` (sized to fit the typical 25k MCP-token cap
  on a single response); raise explicitly up to `100` if the budget
  allows. Each task carries `userId` (primary-assignee UUID, `null` when
  unassigned) and `assignees` (every assignee UUID; empty array when
  unassigned) — both line up with `weeek_list_members.id`. `priority` is
  `null` when no priority is set (otherwise a small integer, commonly
  0–3 — the range is not guaranteed by the API). `truncated` is
  independent: pagination = «more pages exist», truncation = «server
  clipped this page to fit the byte budget».
- `weeek_get_task { task_id } → { id, title, description, completed, projectId, priority, type, userId, assignees, truncated }` —
  a single task by id; `userId` / `assignees` carry the multi-assignee
  UUIDs (matching `weeek_list_members.id`); `priority` may be `null` (no
  priority set). Unknown ids surface as
  `weeek_get_task failed: weeek_not_found`. When the response exceeds
  `MAX_RESPONSE_CHARS`, the server clips `description` and appends a
  `…[truncated]` marker.
- `weeek_list_members {} → { members: [{ id, email, firstName, lastName }], truncated }` —
  every workspace member.
- `weeek_list_tags {} → { tags: [{ id, title, color }], truncated }` — every tag.
- `weeek_list_boards { project_id } → { boards: [{ id, name, projectId, isPrivate }], truncated }` —
  every board in a project. `project_id` is required (Weeek returns HTTP
  422 without it); boards use `name`, not `title`.
- `weeek_list_board_columns { board_id } → { boardColumns: [{ id, name, boardId }], truncated }` —
  every column of a board, in upstream sort order (array order is the
  signal — there is no `position` field). `board_id` is required.

## Write tools

Hidden unless `READ_ONLY=false`. Each one returns the resulting task in **the
same shape `weeek_get_task` returns**, so an agent can read a write's answer
with what it already knows.

- `weeek_complete_task { task_id, completed? (default true) } → { …task }` —
  flips the completion flag and nothing else. `completed: false` re-opens.
  Idempotent: re-firing lands the same state.
- `weeek_move_task { task_id, board_column_id, board_id? } → { …task }` —
  the **status change**: in Weeek a board column *is* a status, so "move
  the card to Done" is this tool, not `weeek_complete_task`. Passing
  `board_id` re-parents the task onto a different board. A task in a Done
  column is not automatically marked completed — the two are separate.
- `weeek_create_task { title, project_id, description?, type?, priority?, board_id?, board_column_id?, assignees?, due_date? } → { …task }` —
  files a new task and returns it with its new id, so no follow-up read is
  needed. **Not idempotent** — each call files a separate task, so never
  re-issue one to check whether it worked.
- `weeek_update_task { task_id, title?, priority?, type?, due_date? } → { …task }` —
  edits an existing task. Only named fields change; at least one is
  required. `null` on `priority` or `due_date` **removes** that value.
  Four fields, not six: Weeek's edit endpoint accepts a `description` or an
  assignee list and **silently ignores** both, so neither is offered here —
  the tool's own description says so as well, so an agent learns it without
  a wasted call (see the limitations below).
- `weeek_set_task_mr_link { task_id, mr_url, custom_field_id?, custom_field_name? } → { …task }` —
  records a merge/pull-request URL in the workspace's MR-link custom field
  and only that field. See
  [the field-naming convention](#the-mr-link-field-naming-convention).

### Two limitations worth knowing

They are not the same kind of limitation:

- **A task description can only be set at create time.** This is Weeek's
  limit, not ours: Public API v1 offers no way to edit a description
  afterwards, under any spelling or verb. An agent that files a
  task with a thin description cannot fix it — it can only file a new task,
  or tell you to edit the description in Weeek's own UI. Both tool
  descriptions say so, so the agent does not have to discover it by trying.
- **Assignees can only be set at create time *here*.** Weeek does have a
  route for changing them, but its semantics are add/remove rather than
  set — "unassign everyone" is not expressible on it, and swapping one
  person for another is two calls. Rather than ship half of that as a
  `weeek_update_task` field that silently does nothing (which is what the
  update endpoint does with an assignee list — 200, ignored), it is left
  out until it can be built as what it is.

### The MR-link field naming convention

`weeek_set_task_mr_link` writes into a Weeek **custom field**, and Weeek has
no canonical "merge request" field — so the tool looks for one by name.
Without `custom_field_id` or `custom_field_name`, it resolves the first
`link`- or `text`-typed custom field named one of:

`MR link` · `MR URL` · `Merge request` · `Merge request URL` · `PR link` ·
`Pull request`

Matching is case- and whitespace-insensitive. Three outcomes, all explicit:

- **exactly one match** → the URL is written there;
- **no match** → an error saying no MR-link field is defined, with the
  candidate names listed. Create one in your workspace under any of those
  names, or pass `custom_field_id` (a field UUID) to skip name resolution
  entirely;
- **two or more matches** → an error rather than a guess. Picking by list
  order would silently write to whichever field happened to come first and
  would look exactly like a correct resolution.

The type requirement is not incidental: a `number`-typed field someone named
"MR link" would take a URL string and, at best, reject it — at worst accept it
with a 200 and drop the value. A field's name alone is not enough to write
into it.

## Truncation

`MAX_RESPONSE_CHARS` (default `65536`) caps `JSON.stringify(structuredContent).length`
per response. Every tool except `ping` and `weeek_get_me` clips its payload to
fit and surfaces a `truncated: boolean` field: the eight gated read tools
(`weeek_list_projects`, `weeek_get_project`, `weeek_list_tasks`,
`weeek_get_task`, `weeek_list_members`, `weeek_list_tags`, `weeek_list_boards`,
`weeek_list_board_columns`) plus all five write tools, which return the
task-detail shape and so inherit the same signal — 13 of the 15 tools.

Lists drop trailing items; the task / project detail shapes clip `description`
with a trailing `…[truncated]` marker. `truncated: false` is returned on every
successful response from every gated tool, so an agent can treat the field as a
stable signal. `ping` and `weeek_get_me` are unaffected — their payloads are
mini-objects bounded under the minimum budget.

`truncated` is orthogonal to pagination: `hasMore` means "more pages exist",
`truncated` means "the server clipped this page to fit the byte budget".

## Tool error format

Every Weeek tool returns `isError: true` with a single-line `text` block of
the shape `<tool> failed (<code>): <human-readable sentence>` when the
upstream API rejects a call. The stable `weeek_<code>` token (machine-grep)
is preserved in parentheses; the trailing English sentence guides the
calling LLM toward the right self-correction path. Examples:

- `weeek_get_task failed (weeek_not_found): Weeek returned 404 for this resource. Verify the id exists in the configured workspace and was not deleted.`
- `weeek_get_me failed (weeek_unauthorized): Weeek rejected the access token (HTTP 401). Check that WEEEK_ACCESS_TOKEN is set, not expired, and copied without surrounding whitespace.`
- `weeek_list_tasks failed (weeek_rate_limited): Weeek rate-limited the request (HTTP 429). Retry after a brief delay or reduce the call frequency.`
- `weeek_list_boards failed (weeek_validation_error): Weeek rejected the request as invalid (HTTP 400/422). Correct the arguments — check ids, required fields, and value types — then retry.`

The mapping from each `weeek_<code>` to its sentence is defined once in
`src/weeek/humanMessage.ts` (covering all nine `WeeekErrorCode`s); response
bodies and `WeeekError.message` are never echoed into the text — only the
code drives the rendered sentence.

Retry semantics are agent-side by design: the server does not retry
upstream calls. The agent decides whether to retry based on the
`weeek_<code>` token — `weeek_rate_limited` / `weeek_server_error` /
`weeek_network` / `weeek_timeout` are retry candidates;
`weeek_unauthorized` / `weeek_forbidden` / `weeek_not_found` are not.
`weeek_validation_error` (HTTP 400 / 422) is retryable **only after
correcting the arguments** — the identical call fails identically.
`weeek_invalid_response` is worth **one** retry; if it persists, the
upstream contract has drifted and no retry count will help.

The full nine-code table — what produces each code, whether to retry, and
the operator action — is [docs/errors.md](errors.md).
