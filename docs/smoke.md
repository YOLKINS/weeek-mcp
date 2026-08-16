# Smoke test

The simplest way to verify the server without any MCP client. Pipes NDJSON
messages via stdin, reads JSON-RPC responses from stdout, ignores stderr logs.

`WEEEK_ACCESS_TOKEN` is required from I3 onwards — every example below sets it.
In a **piped** recipe the env prefix sits on the `node` (server) side of the
`|`, not the `printf` side: the server is the process that must see the token,
so `printf … | WEEEK_ACCESS_TOKEN=… node dist/index.js` is correct and
`WEEEK_ACCESS_TOKEN=… printf … | node dist/index.js` would start the server
tokenless (it would abort before emitting `config loaded`).
`READ_ONLY` defaults to `true` from I5a onwards; the variable is read at
startup and only affects which tools are registered. `ENABLED_TOOLS`
(optional, I5b onwards) is comma-separated; gates intersect.
`MAX_RESPONSE_CHARS` (default `65536`, I5c onwards) caps the per-tool
`structuredContent` size; eight tools clip to fit and surface
`truncated: boolean`.

## Startup stdio cleanliness (INVARIANT-11)

A spawned `dist/index.js` (with a placeholder token) writes **zero
bytes to stdout** in the first ~500 ms — stdout is reserved for the
SDK's JSON-RPC framing — and emits `"msg":"mcp server started"` on
stderr. The `tests/invariants/registry-smoke.test.ts` suite asserts
this on every CI run; the manual recipe below reproduces the same
check by hand.

```bash
WEEEK_ACCESS_TOKEN="$(printf 'a%.0s' {1..40})" \
node dist/index.js < /dev/null > /tmp/weeek-mcp.stdout 2> /tmp/weeek-mcp.stderr &
PID=$!
sleep 0.5
kill -TERM $PID 2>/dev/null
wait $PID 2>/dev/null
wc -c /tmp/weeek-mcp.stdout                                                  # 0
grep -F '"msg":"mcp server started"' /tmp/weeek-mcp.stderr | wc -l           # 1
```

A single non-zero byte on stdout (anything from a `console.log`
that slipped past ESLint to a stray write inside the SDK or a
shutdown hook) corrupts the JSON-RPC stream for every connected
client — INVARIANT-11 is the regression bench for that.

## Startup log shape

Every successful start emits a single `config loaded` line on stderr with
`baseUrl`, `timeoutMs`, `readOnly`, `enabledTools` (`null` when unset,
otherwise a JSON array of tool names), and `maxResponseChars` (an integer).
From I5a onwards a smoke run can sample it:

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n' \
  | WEEEK_ACCESS_TOKEN="$(printf 'a%.0s' {1..40})" node dist/index.js 2>/tmp/weeek-mcp.stderr
grep -F '"msg":"config loaded"' /tmp/weeek-mcp.stderr | grep -F '"readOnly":true'  # 1 hit
grep -F '"enabledTools":null' /tmp/weeek-mcp.stderr        # 1 hit (default)
grep -F '"maxResponseChars":65536' /tmp/weeek-mcp.stderr   # 1 hit (default)
```

Override with `READ_ONLY=false`:

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n' \
  | READ_ONLY=false WEEEK_ACCESS_TOKEN="$(printf 'a%.0s' {1..40})" node dist/index.js 2>/tmp/weeek-mcp.stderr
grep -F '"readOnly":false' /tmp/weeek-mcp.stderr   # 1 hit
```

Since I8 the two modes differ: `READ_ONLY=true` (default) exposes **10**
tools, `READ_ONLY=false` exposes **15** — the ten reads plus
`weeek_complete_task`, `weeek_move_task`, `weeek_create_task`,
`weeek_update_task` and `weeek_set_task_mr_link`. Count them over the wire:

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' \
  | READ_ONLY=false WEEEK_ACCESS_TOKEN="$(printf 'a%.0s' {1..40})" node dist/index.js 2>/dev/null \
  | grep -o '"name":"[a-z_]*"' | wc -l   # 15 (10 under READ_ONLY=true)
```

Each skipped tool also logs one `tool gated by READ_ONLY` line to stderr under
the default, naming itself — so `grep -c 'tool gated by READ_ONLY'` is 5 there
and 0 under `READ_ONLY=false`.

## `ENABLED_TOOLS` — allowlist behavior

Server-side allowlist over tool names, intersected with `READ_ONLY`. Skipped
tools log `tool gated by ENABLED_TOOLS`; unknown names log `unknown tool in
ENABLED_TOOLS` once each. Empty / whitespace-only values abort at env
validation; a list that resolves to zero registered tools aborts before
opening stdio.

### Single tool — `ENABLED_TOOLS=weeek_get_me`

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' \
  | ENABLED_TOOLS="weeek_get_me" WEEEK_ACCESS_TOKEN="$(printf 'a%.0s' {1..40})" node dist/index.js 2>/tmp/weeek-mcp.stderr
grep -F '"enabledTools":["weeek_get_me"]' /tmp/weeek-mcp.stderr | wc -l   # 1
grep -c '"tool gated by ENABLED_TOOLS"' /tmp/weeek-mcp.stderr            # 9
```

Expected stdout (id=2): `tools/list` returns exactly one entry, `weeek_get_me`.

### Two tools — `ENABLED_TOOLS=weeek_get_me,weeek_list_projects`

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' \
  | ENABLED_TOOLS="weeek_get_me,weeek_list_projects" WEEEK_ACCESS_TOKEN="$(printf 'a%.0s' {1..40})" node dist/index.js 2>/tmp/weeek-mcp.stderr
```

Expected: id=2 `tools/list` returns two entries; stderr `config loaded`
contains `"enabledTools":["weeek_get_me","weeek_list_projects"]`; eight
`tool gated by ENABLED_TOOLS` skip lines.

### Empty / whitespace-only — startup abort

```bash
ENABLED_TOOLS="" \
WEEEK_ACCESS_TOKEN="$(printf 'a%.0s' {1..40})" \
node dist/index.js < /dev/null 2>/tmp/weeek-mcp.stderr
echo "exit=$?"   # exit=1
grep -F "ENABLED_TOOLS: must list at least one tool name" /tmp/weeek-mcp.stderr | wc -l   # 1
```

Same outcome for `ENABLED_TOOLS=" "`, `ENABLED_TOOLS=","`, `ENABLED_TOOLS=" , , "`.
The error wraps in the env-validation log line, just like the missing-token
and invalid-`READ_ONLY` cases.

### Unknown name — WARN, not fatal

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' \
  | ENABLED_TOOLS="weeek_get_me,bogus" WEEEK_ACCESS_TOKEN="$(printf 'a%.0s' {1..40})" node dist/index.js 2>/tmp/weeek-mcp.stderr
grep -F '"unknown tool in ENABLED_TOOLS"' /tmp/weeek-mcp.stderr | grep -F '"name":"bogus"' | wc -l   # 1
grep -c '"tool gated by ENABLED_TOOLS"' /tmp/weeek-mcp.stderr   # 9 (the other 9 tools)
```

Expected: id=2 `tools/list` returns exactly one entry, `weeek_get_me`. The
typo surfaces as a WARN line; the server keeps running.

### All-unknown — fail-closed-zero abort

```bash
ENABLED_TOOLS="weeek_create_task" \
WEEEK_ACCESS_TOKEN="$(printf 'a%.0s' {1..40})" \
node dist/index.js < /dev/null 2>/tmp/weeek-mcp.stderr
echo "exit=$?"   # exit=1
grep -F '"unknown tool in ENABLED_TOOLS"' /tmp/weeek-mcp.stderr | grep -F '"name":"weeek_create_task"' | wc -l   # 1
grep -F 'no tools registered' /tmp/weeek-mcp.stderr | wc -l   # 1
```

The env validation accepts the literal string; the WARN fires; then the
registry-level fail-closed-zero throw aborts the process before
`server.connect()` opens stdio.

### Dedupe — silent

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' \
  | ENABLED_TOOLS="ping,ping" WEEEK_ACCESS_TOKEN="$(printf 'a%.0s' {1..40})" node dist/index.js 2>/tmp/weeek-mcp.stderr
grep -F '"enabledTools":["ping"]' /tmp/weeek-mcp.stderr | wc -l   # 1
grep -c '"unknown tool in ENABLED_TOOLS"' /tmp/weeek-mcp.stderr   # 0 (dedupe is quiet)
```

### Intersection — `READ_ONLY=true ENABLED_TOOLS=ping`

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' \
  | READ_ONLY=true ENABLED_TOOLS="ping" WEEEK_ACCESS_TOKEN="$(printf 'a%.0s' {1..40})" node dist/index.js 2>/tmp/weeek-mcp.stderr
```

Expected: 1 tool (`ping` is read-only and in the allowlist). Same outcome
under `READ_ONLY=false ENABLED_TOOLS=ping` — the allowlist is the binding
constraint there.

## `MAX_RESPONSE_CHARS` — truncation behaviour

Server-side cap on `JSON.stringify(structuredContent).length` per tool
response. Eight tools (`weeek_list_projects`, `weeek_get_project`,
`weeek_list_tasks`, `weeek_get_task`, `weeek_list_members`,
`weeek_list_tags`, `weeek_list_boards`, `weeek_list_board_columns`) clip
their payload and surface `truncated: boolean` in `outputSchema`. `ping` and
`weeek_get_me` are unaffected (their payloads stay under the min budget by
construction).

Clipping strategies:
- **Lists** drop trailing items via binary search (largest prefix that fits).
- **`weeek_get_task` / `weeek_get_project`** clip only `description` and
  append the ASCII-safe marker `…[truncated]`. If `description` is `null` or
  even an empty description plus marker overflows, falls back to
  `truncated:true` with no description text change (or marker-only).

On truncation, exactly one stderr line is emitted:
`{"msg":"response truncated","tool":"…","maxResponseChars":n,"originalChars":n,"truncatedChars":n}`.
Metrics only — no titles / ids / descriptions / secrets.

### Default budget — `truncated:false` everywhere

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n' \
  | WEEEK_ACCESS_TOKEN="$(printf 'a%.0s' {1..40})" node dist/index.js 2>/tmp/weeek-mcp.stderr
grep -F '"maxResponseChars":65536' /tmp/weeek-mcp.stderr | wc -l   # 1
```

### Custom budget — `MAX_RESPONSE_CHARS=2048`

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n' \
  | MAX_RESPONSE_CHARS=2048 WEEEK_ACCESS_TOKEN="$(printf 'a%.0s' {1..40})" node dist/index.js 2>/tmp/weeek-mcp.stderr
grep -F '"maxResponseChars":2048' /tmp/weeek-mcp.stderr | wc -l   # 1
```

### Invalid values — startup abort

`MAX_RESPONSE_CHARS=0` rejected by the `min(1024)` constraint:

```bash
MAX_RESPONSE_CHARS=0 \
WEEEK_ACCESS_TOKEN="$(printf 'a%.0s' {1..40})" \
node dist/index.js < /dev/null 2>/tmp/weeek-mcp.stderr
echo "exit=$?"   # exit=1
grep -F "MAX_RESPONSE_CHARS: Number must be greater than or equal to 1024" /tmp/weeek-mcp.stderr | wc -l   # 1
```

`MAX_RESPONSE_CHARS=abc` rejected by `z.coerce.number().int()`:

```bash
MAX_RESPONSE_CHARS=abc \
WEEEK_ACCESS_TOKEN="$(printf 'a%.0s' {1..40})" \
node dist/index.js < /dev/null 2>/tmp/weeek-mcp.stderr
echo "exit=$?"   # exit=1
grep -F "MAX_RESPONSE_CHARS: Expected number, received nan" /tmp/weeek-mcp.stderr | wc -l   # 1
```

`MAX_RESPONSE_CHARS=2000000` rejected by `max(1_000_000)`:

```bash
MAX_RESPONSE_CHARS=2000000 \
WEEEK_ACCESS_TOKEN="$(printf 'a%.0s' {1..40})" \
node dist/index.js < /dev/null 2>/tmp/weeek-mcp.stderr
echo "exit=$?"   # exit=1
grep -F "MAX_RESPONSE_CHARS: Number must be less than or equal to 1000000" /tmp/weeek-mcp.stderr | wc -l   # 1
```

### Live truncation proof — requires real token (Live)

A stub token bounces every `weeek_*` call through `weeek_unauthorized`, so
the helper short-circuits on `isError:true` and truncation cannot be
demonstrated. The recipes below need a real `WEEEK_ACCESS_TOKEN` against a
workspace with enough data.

`weeek_list_tasks` under a tight budget — expect a clipped page:

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"weeek_list_tasks","arguments":{"per_page":100}}}\n' \
  | MAX_RESPONSE_CHARS=2048 WEEEK_ACCESS_TOKEN="<TOK>" node dist/index.js 2>/tmp/weeek-mcp.stderr > /tmp/weeek-mcp.stdout
grep -F '"response truncated"' /tmp/weeek-mcp.stderr | grep -F '"tool":"weeek_list_tasks"' | wc -l   # ≥ 1
```

Expected stdout (id=2): `result.structuredContent.truncated === true`,
`tasks.length < 100`, `JSON.stringify(structuredContent).length ≤ 2048`.
The helper drops trailing tasks until the response fits.

`weeek_get_task` against a task with a long description (>2 KB) under a
tight budget — expect `description` to end with `…[truncated]`:

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"weeek_get_task","arguments":{"task_id":<long-desc-id>}}}\n' \
  | MAX_RESPONSE_CHARS=2048 WEEEK_ACCESS_TOKEN="<TOK>" node dist/index.js 2>/tmp/weeek-mcp.stderr > /tmp/weeek-mcp.stdout
grep -F '"response truncated"' /tmp/weeek-mcp.stderr | grep -F '"tool":"weeek_get_task"' | wc -l   # 1
```

Expected stdout (id=2): `result.structuredContent.truncated === true` and
`description.endsWith("…[truncated]") === true`.

Default budget regression — same task, no truncation:

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"weeek_list_tasks","arguments":{"per_page":5}}}\n' \
  | WEEEK_ACCESS_TOKEN="<TOK>" node dist/index.js 2>/tmp/weeek-mcp.stderr > /tmp/weeek-mcp.stdout
grep -F '"response truncated"' /tmp/weeek-mcp.stderr | wc -l   # 0
```

### Composition — `READ_ONLY=true ENABLED_TOOLS=weeek_list_tasks MAX_RESPONSE_CHARS=2048`

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' \
  | READ_ONLY=true ENABLED_TOOLS=weeek_list_tasks MAX_RESPONSE_CHARS=2048 WEEEK_ACCESS_TOKEN="$(printf 'a%.0s' {1..40})" node dist/index.js 2>/tmp/weeek-mcp.stderr
```

Expected: id=2 returns one tool (`weeek_list_tasks`); under a real token a
`tools/call` against it would clip to ≤ 2048 chars and emit a `response
truncated` line. All three gates compose without interference.

## Prerequisites

```bash
npm install
npm run build
```

## Happy path — `ping` only (no Weeek call)

A real-looking 40-character stub token satisfies `min(20)` and the
placeholder/whitespace refinements. The Weeek API is not contacted because the
flow stops after `tools/list`.

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ping","arguments":{"msg":"hi"}}}\n' \
  | WEEEK_ACCESS_TOKEN="$(printf 'a%.0s' {1..40})" node dist/index.js 2>/tmp/weeek-mcp.stderr
```

Expected stdout (one JSON per line):

1. id=1 — `initialize` result with `protocolVersion`, `capabilities: {tools:{}}`, `serverInfo`.
2. (no response — `notifications/initialized` is a notification)
3. id=2 — `tools/list` with **ten** tools (in registration order): `ping`,
   `weeek_get_me`, `weeek_list_projects`, `weeek_get_project`,
   `weeek_list_tasks`, `weeek_get_task`, `weeek_list_members`,
   `weeek_list_tags`, `weeek_list_boards`, `weeek_list_board_columns`. Each
   Weeek tool carries
   `annotations: {readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:true}`
   and an `outputSchema`.
4. id=3 — `tools/call ping` result with `content: [{type:"text",text:"pong: hi"}]`.

## Authenticated happy paths (require a real token)

`<TOK>` below stands for a real Weeek API token. Each block calls one
tool. Stdout responses are NDJSON; stderr is logger-only and ignored unless
explicitly sampled.

### `weeek_get_me`

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"weeek_get_me","arguments":{}}}\n' \
  | WEEEK_ACCESS_TOKEN="<TOK>" node dist/index.js 2>/tmp/weeek-mcp.stderr
```

Expected: id=2 response carries `result.structuredContent.{id,email,name}`,
where `email` matches the Weeek account that issued the token. `name` is
either the explicit `name` field (if Weeek ever adds one) or `firstName +
lastName` joined by a space, with a fallback to `email` when both name parts
are absent.

### `weeek_list_projects`

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"weeek_list_projects","arguments":{}}}\n' \
  | WEEEK_ACCESS_TOKEN="<TOK>" node dist/index.js 2>/tmp/weeek-mcp.stderr
```

Expected: `result.structuredContent.{projects:[…], truncated:false}`. Each
project entry has `{id:number, title:string, color:string, isPrivate:boolean}`.
`content[0].text` renders `"<n> project(s)"`. Under default
`MAX_RESPONSE_CHARS=65536` the gate does not fire on common workspaces;
`truncated:true` only appears when the budget is exceeded (see I5c section).

### `weeek_get_project`

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"weeek_get_project","arguments":{"project_id":123}}}\n' \
  | WEEEK_ACCESS_TOKEN="<TOK>" node dist/index.js 2>/tmp/weeek-mcp.stderr
```

Expected: `result.structuredContent.{id, title, description, color,
isPrivate, truncated:false}` — the detail variant is the only tool that
returns a project's `description` (the list variant omits it).
`content[0].text` renders `"#<id> <title>"`. `project_id` is a required input
(a missing one is rejected by zod as `MCP error -32602: Input validation
error`); for an unknown id (or one not visible to the token) expect
`result.isError: true` and `content[0].text` starting `weeek_get_project
failed (weeek_not_found): …`. When `description` is long enough that the
response would exceed `MAX_RESPONSE_CHARS`, the gate clips it and ends with
the marker `…[truncated]`; `truncated` flips to `true`.

### `weeek_list_tasks` (paginated)

Page 1:

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"weeek_list_tasks","arguments":{"per_page":5,"offset":0}}}\n' \
  | WEEEK_ACCESS_TOKEN="<TOK>" node dist/index.js 2>/tmp/weeek-mcp.stderr
```

Expected: `result.structuredContent.{tasks:[…], hasMore:boolean, truncated:false}`.
Each task carries `{id, title, completed, projectId, priority, type, userId,
assignees}`, where `userId` is the primary-assignee UUID (`null` when
unassigned) and `assignees` is the array of every assignee UUID (empty when
unassigned); both line up with `weeek_list_members.id`.
If `hasMore` is `true`, call again with `offset = 5` to fetch page 2.
`completed: true` filters to completed tasks only; `completed: false` to
open ones. `project_id` filters to a project. `hasMore` and `truncated` are
independent: `hasMore` reports Weeek pagination, `truncated` reports the
local byte-budget gate (only `true` when the response was clipped).

### `weeek_get_task`

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"weeek_get_task","arguments":{"task_id":123}}}\n' \
  | WEEEK_ACCESS_TOKEN="<TOK>" node dist/index.js 2>/tmp/weeek-mcp.stderr
```

Expected: `result.structuredContent.{id, title, description, completed,
projectId, priority, type, userId, assignees, truncated:false}`, where
`userId` (primary-assignee UUID, `null` when unassigned) and `assignees`
(every assignee UUID; empty when unassigned) match `weeek_list_members.id`.
`content[0].text` renders `"#<id> <title>"`. For an unknown id (or one not
visible to the configured token), expect `result.isError: true` and
`content[0].text === "weeek_get_task failed: weeek_not_found"`. When
`description` is long enough that the response would exceed
`MAX_RESPONSE_CHARS`, the gate clips it and ends with the marker
`…[truncated]`; `truncated` flips to `true`.

### `weeek_list_members`

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"weeek_list_members","arguments":{}}}\n' \
  | WEEEK_ACCESS_TOKEN="<TOK>" node dist/index.js 2>/tmp/weeek-mcp.stderr
```

Expected: `result.structuredContent.{members:[…], truncated:false}` —
each member is `{id:string, email:string, firstName:string|null,
lastName:string|null}`. Member `id` is **string**, unlike most other Weeek
resources.

### `weeek_list_tags`

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"weeek_list_tags","arguments":{}}}\n' \
  | WEEEK_ACCESS_TOKEN="<TOK>" node dist/index.js 2>/tmp/weeek-mcp.stderr
```

Expected: `result.structuredContent.{tags:[…], truncated:false}` — each
tag is `{id, title, color}`.

### `weeek_list_boards`

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"weeek_list_boards","arguments":{"project_id":123}}}\n' \
  | WEEEK_ACCESS_TOKEN="<TOK>" node dist/index.js 2>/tmp/weeek-mcp.stderr
```

Expected: `result.structuredContent.{boards:[…], truncated:false}` — each
board is `{id:number, name:string, projectId:number, isPrivate:boolean}`.
Boards use `name`, not `title`. `content[0].text` renders `"<n> board(s)"`.
`project_id` is a required input: a missing one is rejected by zod (`MCP
error -32602: Input validation error`), and an unknown project surfaces the
upstream HTTP 422 as `result.isError: true` with `content[0].text` starting
`weeek_list_boards failed (weeek_validation_error): …`.

### `weeek_list_board_columns`

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"weeek_list_board_columns","arguments":{"board_id":123}}}\n' \
  | WEEEK_ACCESS_TOKEN="<TOK>" node dist/index.js 2>/tmp/weeek-mcp.stderr
```

Expected: `result.structuredContent.{boardColumns:[…], truncated:false}` —
each column is `{id:number, name:string, boardId:number}`, in the upstream
array order (the only sort signal — there is no `position` field, so the
tool preserves the order verbatim). `content[0].text` renders `"<n>
column(s)"`. `board_id` is a required input: a missing one is rejected by zod
(`MCP error -32602: Input validation error`), and an unknown board surfaces
the upstream HTTP 422 as `result.isError: true` with `content[0].text`
starting `weeek_list_board_columns failed (weeek_validation_error): …`.

## Negative paths

### Missing token at startup

```bash
unset WEEEK_ACCESS_TOKEN
node dist/index.js < /dev/null 2>/tmp/weeek-mcp.stderr
echo "exit=$?"   # exit=1
```

Expected stderr is **one line of structured JSON** with the env error
embedded as a multi-line string in the `err` field:

```json
{"t":"…","level":"error","msg":"fatal: main() rejected","err":"invalid env:\n  WEEEK_ACCESS_TOKEN: Required"}
```

The literal substring `WEEEK_ACCESS_TOKEN: Required` is present (preceded by
the JSON-escaped `\n  `); the single-line form `invalid env: WEEEK_ACCESS_TOKEN:
Required` does **not** appear. Verify with:

```bash
grep -c 'WEEEK_ACCESS_TOKEN: Required' /tmp/weeek-mcp.stderr   # 1
```

### Invalid `READ_ONLY` → startup abort

```bash
READ_ONLY=maybe \
WEEEK_ACCESS_TOKEN="$(printf 'a%.0s' {1..40})" \
node dist/index.js < /dev/null 2>/tmp/weeek-mcp.stderr
echo "exit=$?"   # exit=1
grep -F "READ_ONLY: must be 'true' | 'false' | '1' | '0'" /tmp/weeek-mcp.stderr | wc -l   # 1
```

Like the missing-token case, the env error is wrapped in a single JSON log
line under the `err` field. The literal substring above is present.

### Invalid token → tool error (not protocol error)

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"weeek_get_me","arguments":{}}}\n' \
  | WEEEK_ACCESS_TOKEN="$(printf 'b%.0s' {1..40})" node dist/index.js 2>/tmp/weeek-mcp.stderr
```

Expected: id=2 response has `result.isError: true` and a stable
`content[0].text` of `weeek_get_me failed: weeek_unauthorized`. No token
fragments anywhere on stdout or stderr.

### Timeout

Point the client at a non-routable host so the request hangs until
`WEEEK_TIMEOUT_MS` fires.

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"weeek_get_me","arguments":{}}}\n' \
  | WEEEK_ACCESS_TOKEN="$(printf 'a%.0s' {1..40})" WEEEK_BASE_URL="https://10.255.255.1/public/v1" WEEEK_TIMEOUT_MS=2000 node dist/index.js 2>/tmp/weeek-mcp.stderr
```

Expected: id=2 has `result.isError: true` with code `weeek_timeout`.

### Unknown tool / unknown method / missing args (regression of I1 paths)

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"ping","arguments":{}}}\n{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"nonexistent","arguments":{}}}\n{"jsonrpc":"2.0","id":12,"method":"totally/unknown"}\n' \
  | WEEEK_ACCESS_TOKEN="$(printf 'a%.0s' {1..40})" node dist/index.js 2>/dev/null
```

Expected (SDK 1.29 wraps tool-level errors into `result.isError`; only
unknown JSON-RPC methods come back as protocol errors):

- id=10 → `result.isError: true`, `content[0].text` starts with
  `MCP error -32602: Input validation error: Invalid arguments for tool ping:`
  (missing required `msg`).
- id=11 → `result.isError: true`, `content[0].text === "MCP error -32602:
  Tool nonexistent not found"`.
- id=12 → JSON-RPC protocol error `error.code: -32601` with
  `message: "Method not found"`.

### `weeek_list_tasks` / `weeek_get_task` — invalid args (zod validation)

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"weeek_list_tasks","arguments":{"completed":"yes"}}}\n{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"weeek_list_tasks","arguments":{"per_page":1000}}}\n{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"weeek_list_tasks","arguments":{"offset":-1}}}\n{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"weeek_get_task","arguments":{"task_id":-1}}}\n' \
  | WEEEK_ACCESS_TOKEN="$(printf 'a%.0s' {1..40})" node dist/index.js 2>/dev/null > /tmp/i4-invalid-args.stdout
cat /tmp/i4-invalid-args.stdout
```

Expected: each of id=2..5 returns `result.isError: true` with
`content[0].text` starting `MCP error -32602: Input validation error: …`.
Since D4 (#41) every tool input is snake_case. How a leftover camelCase
argument surfaces depends on whether the input it shadows is required:
`weeek_get_task {"id":123}`, `weeek_get_project {"projectId":1}`,
`weeek_list_boards {"projectId":1}` and
`weeek_list_board_columns {"boardId":1}` all fail loudly here — the required
snake_case input is missing. `weeek_list_tasks` is the exception: its inputs
are optional, so `{"projectId":5,"perPage":5}` parses successfully with both
unknown keys stripped, and the call returns an *unfiltered* first page of 20.
Read the echoed arguments, not just the status, when a task list looks wider
than expected.
The serialized zod issue includes `code` (`invalid_type`/`too_big`/
`too_small`), `path` (e.g. `["completed"]`, `["per_page"]`), and (for
`invalid_type`) a `received` field set to the JS `typeof` (`"string"`,
`"number"`) — **not the user's actual value**. Verify no echo:

```bash
grep -F '"yes"' /tmp/i4-invalid-args.stdout | wc -l   # 0
grep -F '1000'  /tmp/i4-invalid-args.stdout | wc -l   # 0  (the constraint says 100)
```

If either grep returns >0, the SDK behavior changed and I1-M3 must be
re-opened.

### `weeek_get_task` — unknown id (404 → tool error, not protocol error)

Requires a real token; for an id known not to exist:

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"weeek_get_task","arguments":{"task_id":999999999}}}\n' \
  | WEEEK_ACCESS_TOKEN="<TOK>" node dist/index.js 2>/dev/null
```

Expected: `result.isError: true`, `content[0].text === "weeek_get_task
failed: weeek_not_found"`.

## Secret-leak check

The stub recipes set the token as a command prefix, which does **not** export
it to your interactive shell — so `grep -F "$WEEEK_ACCESS_TOKEN"` would expand
to an empty pattern and match every line. Capture the value in a shell
variable first, then reuse it both as the server's env prefix and as the grep
needle:

```bash
TOK="$(printf 'a%.0s' {1..40})"
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n' \
  | WEEEK_ACCESS_TOKEN="$TOK" node dist/index.js 2>/tmp/weeek-mcp.stderr
grep -F "$TOK" /tmp/weeek-mcp.stderr | wc -l   # 0
```

This catches accidental token logging from any layer (env loader, HTTP client,
tool handler). The `ENABLED_TOOLS` allowlist also writes its own log lines —
re-run with the allowlist active and confirm:

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n' \
  | ENABLED_TOOLS=ping WEEEK_ACCESS_TOKEN="$TOK" node dist/index.js 2>/tmp/weeek-mcp.stderr
grep -F "$TOK" /tmp/weeek-mcp.stderr | wc -l   # 0
```

The tool name and the `enabledTools` array reach stderr as-is (they are not
secrets and not in `REDACT_KEYS`), but no token fragment must leak via the
new code paths (`config loaded` log, skip-info, unknown-name WARN).

The I5c `response truncated` log carries only `tool`, `maxResponseChars`,
`originalChars`, `truncatedChars` — never list items, ids, titles, or
descriptions. Verify the prefix appears (with a real token under a tight
budget) but no token fragment leaks:

```bash
grep -F '"response truncated"' /tmp/weeek-mcp.stderr | grep -F "$TOK" | wc -l   # 0
```

## Inspector (preferred interactive test)

```bash
WEEEK_ACCESS_TOKEN="<your-real-weeek-token>" npm run inspect
```

Runs `npx @modelcontextprotocol/inspector node dist/index.js` and opens a UI
where you can see the handshake, browse all ten read tools (`ping`,
`weeek_get_me`, `weeek_list_projects`, `weeek_get_project`,
`weeek_list_tasks`, `weeek_get_task`, `weeek_list_members`,
`weeek_list_tags`, `weeek_list_boards`, `weeek_list_board_columns`), and call
them with a form. Add `READ_ONLY=false` to the command to browse the five
write tools alongside them — with a real token that Inspector session can
change the workspace, so point it at a sandbox. Outputs render against each
tool's `outputSchema`; every tool but `ping` and `weeek_get_me` surfaces a
`truncated: boolean` field. The Inspector is the
cheapest way to catch upstream-shape drift — if Weeek ever changes a payload
field, the SDK will reject the `structuredContent` and the call surfaces as
`isError: true` here before any consumer notices.

To exercise I5c interactively, restart with `MAX_RESPONSE_CHARS=2048
npm run inspect` and call `weeek_list_tasks {per_page:100}` against a busy
workspace — the response should clip to fewer items with `truncated:true`.
