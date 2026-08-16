# Weeek API notes

Captured at the start of I4 from <https://developers.weeek.net> (search-engine
indexed responses; the docs site is an SPA and is not directly fetchable). All
paths below are relative to the configured base URL (default
`https://api.weeek.net/public/v1`). Authentication is `Authorization: Bearer
<WEEEK_ACCESS_TOKEN>` for every call (see `src/weeek/client.ts`). Every
2xx response is an envelope of the form `{ success: true, <key>: ... }` —
`parseWeeekResponse<T>(status, body, "<key>")` already handles this.

> **How to refresh.** When the upstream API changes, run `curl
> -H "Authorization: Bearer $WEEEK_ACCESS_TOKEN"
> https://api.weeek.net/public/v1/<path>` for each endpoint below, diff the
> response shape, and update this file. Do not paste real responses
> here — they may contain tenant data.

## Drift policy: envelope strict, fields tolerant

Every 2xx response is a two-layer shape, and the parser mirrors it in two
layers with **deliberately different failure modes** (I7.5; ADR 0003,
spec #32):

- **Envelope layer — strict.** `parseWeeekResponse<T>(status, body, "<key>")`
  (`src/weeek/unwrap.ts`) rejects a non-2xx status, a non-object body,
  `success !== true`, or a missing top-level `<key>` (`user` / `projects` /
  `tasks` / …) with `weeek_invalid_response`. A broken envelope means "this is
  not the API I think I'm talking to", so it **fails loud** — degrading here
  would mask a wrong base URL, an auth wall, or an HTML error page.

- **Inner-field layer — tolerant.** Everything past a successfully-unwrapped
  resource flows through `shapeField` / `shapeList` (`src/weeek/shape.ts`).
  Each inner field degrades to a **schema-valid default of its declared kind**
  instead of throwing, so a cosmetic upstream rename or a single drifted field
  degrades that one field on that one row rather than erroring the whole call:

  | Drift | Result | Warn tag |
  |---|---|---|
  | required scalar wrong/absent | `""` / `0` / `false` | `endpoint:field` |
  | nullable scalar legitimately null/absent | `null` (not a fallback — no warn) | — |
  | nullable scalar present-but-wrong-type | `null` | `endpoint:field` |
  | array field present but non-array | `[]` | `endpoint:field` |
  | **list** container present but non-array | `[]` | `endpoint:_container` |
  | non-object **list** entry inside a valid array | dropped | `endpoint:_entry` |
  | **detail** resource that is not an object | hard `weeek_invalid_response` throw | — |

  A **detail** resource keeps the strict throw on purpose: a detail can't
  "drop" the way a list entry can, and a fully-synthetic all-defaults record
  would look successful but be garbage (ADR 0003). The catch is split across
  the two layers: a `null`/primitive detail is already rejected by the strict
  envelope above; an **array** detail clears the envelope's
  `typeof === "object"` gate, so each detail parser re-guards it with its own
  `asJson` / `invalid` check before shaping any field. The `endpoint` tag is the
  tool name minus `weeek_` (e.g. `list_boards`, `get_project`).

**Observability, not silence.** When a fallback fires, a de-duplicated `warn`
line — one per `endpoint:field` for the life of the process, so a drifted field
on a 500-row list logs **once** — goes to stderr carrying the `endpoint:field`
**name only**, never the drifted value (INVARIANT-2). `ShapeCtx.silent` lets an
operator mute a known, acknowledged drift.

**Why this is a refactor, not a break (Gate B).** Every degraded value is
schema-valid, and every read tool's `outputSchema` is byte-frozen — locked by
`tests/invariants/output-schema-freeze.test.ts`. The single behavioural delta
of the I7.5 migration is that invalid/absent **inner** input now degrades to a
default instead of raising `weeek_invalid_response`; the tool surface is
unchanged.

## Endpoint summary

| Tool (I3/I4) | Method | Path | Envelope key | Pagination | Notes |
|---|---|---|---|---|---|
| `weeek_get_me` (I3) | GET | `/user/me` | `user` | n/a | Returns single profile object (see [§ /user/me](#usermesoftware)). |
| `weeek_list_projects` | GET | `/tm/projects` | `projects` | none documented | Plan said `/ws/projects` — **wrong**, the real path is under `/tm/`. |
| `weeek_get_project` (I7) | GET | `/tm/projects/{id}` | `project` | n/a | Singular envelope key (matches `/user/me` and `/tm/tasks/{id}` precedent). `id` is the integer project identifier. |
| `weeek_list_tasks` | GET | `/tm/tasks` | `tasks` | `offset` (int) + `perPage` (int) + response `hasMore` (bool) | Plan said `cursor`/`limit` — wrong; real Weeek pagination is offset-based. |
| `weeek_get_task` | GET | `/tm/tasks/{id}` | `task` | n/a | `id` is the integer task identifier. |
| `weeek_list_boards` (I7) | GET | `/tm/boards?projectId={int}` | `boards` | none documented | New in I7 (G2). `projectId` is **required** as a query param — `/tm/boards` without it returns 422. Element uses `name`, not `title`. |
| `weeek_list_board_columns` (I7) | GET | `/tm/board-columns?boardId={int}` | `boardColumns` | none documented | New in I7 (G2). Path is hyphenated `/tm/board-columns`, **not** `/tm/boards/{id}/columns`. `boardId` is required. |
| `weeek_list_members` | GET | `/ws/members` | `members` | none documented | Member `id` is **string** (vs. integer for tasks/projects/tags). |
| `weeek_list_tags` | GET | `/ws/tags` | `tags` | none documented | Tag `id` is integer (≥ 1). |
| `weeek_complete_task` (I8) | POST | `/tm/tasks/{id}/complete` · `/tm/tasks/{id}/un-complete` | *(ack only)* | n/a | New in I8 (#43), the first **write**. Bodyless; answers `{success:true}` with no task echo, so the tool reads the task back for its result. Route existence + the hyphenated `un-complete` spelling probe-confirmed 2026-07-22 (see [§ write](#tmtasksidcomplete-and-tmtasksidun-complete-write)). |
| `weeek_move_task` (I8) | PUT | `/tm/tasks/{id}` | `task` | n/a | New in I8 (#44), the status-change write. Body `{boardColumnId}` = same-board move, `{boardId, boardColumnId}` = cross-board re-parent (probe #12). Answers with the full updated task, so no read-back (see [§ update](#tmtasksid-update--the-write-transport)). Deprecated-parameter liability: API-03. |
| `weeek_create_task` (I8) | POST | `/tm/tasks` | `task` | n/a | New in I8 (#45). Same path as the list read, under the write verb. Answers with the full new task, so the caller gets the new id without a read-back. Body: `title` + `projectId` required *by us*, seven optionals all live-probed (see [§ create](#tmtasks-create--the-write-transport)). Deprecated-parameter liability: API-03. |
| `weeek_set_task_mr_link` (I8) | PUT | `/tm/tasks/{id}` | `task` | n/a | New in I8 (#47). Third tool on the same `PUT`, with a body key disjoint from the other two: `{"customFields": {"<uuid>": "<url>"}}` — a **MAP keyed by field id**; the array form the read echoes back is accepted with a 200 and **silently discarded** (probe #12, see [§ custom fields](#the-custom-fields-write-an-array-to-read-a-map-to-write-probe-12)). Resolves the field id from `GET /tm/custom-fields` when only a name is available. |
| `weeek_update_task` (I8) | PUT | `/tm/tasks/{id}` | `task` | n/a | New in I8 (#46), the field edit. Same transport as `weeek_move_task`, deliberately disjoint input surface. Body carries **only** the named fields; four are editable (`title`, `priority`, `type`, `dueDate`) and `description` / `assignees` are **not** — both answer 200 and change nothing (probe #46, see [§ update](#tmtasksid-update--the-write-transport)). An empty body is a 200 no-op, so the tool refuses it without issuing a request. |

## /user/me

```jsonc
{
  "success": true,
  "user": {
    "id": <int|string>,
    "email": "...",
    "logoLink": "...|null",
    "firstName": "...|null",
    "lastName": "...|null",
    "middleName": "...|null",
    "about": "...",
    "position": "...",
    "language": "...",
    "birthDate": "...",
    "country": "...",
    "timeZone": "...",
    "phoneNumber": "..."
  }
}
```

**There is no `name` field.** This contradicts `src/weeek/types.ts:42-46` and
`src/weeek/endpoints.ts:13-21`, which require `name: string`. The
fix: `weeek_get_me` is patched in I4 to derive a display
name from `firstName`/`lastName` (joined with a space, trimmed) and fall back
to `email` if both name parts are absent. The `MeResponse.name` field is
preserved in the tool output schema so existing callers don't break.

## /tm/projects (list)

```jsonc
{
  "success": true,
  "projects": [
    {
      "id": <int>,
      "title": "...",
      "logoLink": "...|null",
      "description": "...|null",
      "color": "...",
      "isPrivate": <bool>,
      "team": ["<userId>", ...],
      "customFields": [...]
    }
  ]
}
```

Pagination: not documented. Treat as "returns the full list". I4 tool
`weeek_list_projects` exposes only `{}` input until pagination is confirmed.

`outputSchema` for `weeek_list_projects` carries
`{ projects: [{id, title, color, isPrivate}], truncated: boolean }`.
`description`, `logoLink`, `team`, `customFields` are intentionally omitted
to keep the contract narrow (same discipline as `MeResponse`: avoid
passthrough so an upstream change does not silently mutate our schema).
`truncated` is the I5c byte-budget signal — see README and `_response-limits.ts`.

## /tm/projects/{id} (get one)

```jsonc
{
  "success": true,
  "project": {
    "id": <int>,
    "title": "...",
    "name": "...",
    "logoLink": "...|null",
    "description": "...|null",
    "color": "...",
    "status": <int>,
    "isPrivate": <bool>,
    "portfolioId": <int|null>,
    "team": ["<uuid>", ...],
    "customFields": [...]
  }
}
```

Probe (2026-05-13) confirmed three fields beyond the list-row
shape: `name` (separate string from `title`; appears to be the
internal slug while `title` is the UI label), `status` (numeric
enum — value `1` observed; semantics not documented), and
`portfolioId` (nullable integer foreign key). `team[]` elements are
**UUID strings**, matching `/ws/members.id` — the existing list
section's `"<userId>"` placeholder reads as a string for the same
reason. `color` is a 7-char `#xxxxxx` hex string.

> **Reconciliation (audit §5.3):** the OpenAPI spec declares `name` and
> **no `title`**, and the rendered docs treat `name` as *the* project
> name — so the "internal slug" reading above is **[UNVERIFIED]**. The
> likelier story is a `title`→`name` rename that kept `title` as an
> undocumented alias (same pattern as the deprecated `projectId`). See
> the read-surface
> audit (2026-07-15) §5.3.

The detail envelope key is **singular** (`project`, not `projects`),
matching the `/user/me` and `/tm/tasks/{id}` convention. The field
set extends the list-row payload — the only practical difference for
the agent is that the detail variant is the natural place to read
`description`, which the I7 `outputSchema` exposes; the list-row
contract narrows to `{id, title, color, isPrivate}` without
`description` so that a large `weeek_list_projects` response stays
well under the `MAX_RESPONSE_CHARS` budget.

I7 tool `weeek_get_project { projectId }` exposes
`{id, title, description, color, isPrivate, truncated}` as
`outputSchema`. `name`, `logoLink`, `status`, `portfolioId`, `team`,
`customFields` are intentionally omitted (same passthrough
discipline as `MeResponse` / `ProjectSummary`). `description` is
the only variable-length field on the detail shape and is the
single lever that `applyResponseLimits` clips when the response
exceeds the budget — the clipped text ends with the marker
`…[truncated]`.

Unknown ids surface at the `WeeekClient` 404 layer as
`weeek_not_found` and reach the agent as
`weeek_get_project failed (weeek_not_found): <humanMessage>`.

## /tm/tasks (list)

```jsonc
{
  "success": true,
  "tasks": [
    {
      "id": <int>,
      "parentId": <int|null>,
      "title": "...",
      "description": "...|null",
      "type": "action" | "meet" | "call",
      "priority": 0 | 1 | 2 | 3 | null,
      "projectId": <int>,
      "duration": <int|null>,
      "overdue": <int>,
      "isCompleted": <bool>,
      "userId": "<uuid>",
      "assignees": ["<uuid>", ...],
      "locations": [
        { "projectId": <int>, "boardId": <int|null>, "boardColumnId": <int|null> },
        ...
      ]
      // ... more fields
    }
  ],
  "hasMore": <bool>
}
```

> **Shape correction (bug #25 / #27, live-probed 2026-07-21).** Three fields
> differ from the pre-fix documentation. (1) The completion flag on the wire is
> **`isCompleted`**, not `completed` — there is no `completed` key on a real
> task; `taskSummaryFromJson` / `taskDetailFromJson` now read `isCompleted`
> (strict boolean, no legacy `completed` fallback), while the normalized tool
> **output** field stays `completed`. (2) `priority` is **nullable** — the API
> returns `null` for an unprioritised task (0–3 is the common range but not
> guaranteed by the API); both parsers and both tool `outputSchema`s accept
> `number | null` and pass `null` through verbatim. (3) `locations[]` is
> present — the spec's `required` replacement for the deprecated `projectId`
> trio; element shape `{ projectId, boardId|null, boardColumnId|null }` per the
> read-surface audit (2026-07-15) §5.1.
> We document it but do **not** expose it as a tool field yet (the tools still
> read the live-served `projectId`; that migration is API-03).

> **Reconciliation (audit §5.1):** `projectId` on the task object was
> officially **deprecated 2025-05-18** (30-day grace, long expired); the
> spec drops it from the declared task schema in favour of `locations[]`
> (marked `required`). The live API still serves `projectId` — the probe
> saw it on 2026-05-13 — so the tools still read it, but it is a field
> upstream has announced the removal of, and `locations[]` is not yet
> read. See the read-surface
> audit (2026-07-15) §5.1
> (tracked as API-03).

Documented query parameters: `day`, `userId`, `projectId`, `completed`,
`boardId`, `boardColumnId`, `type`, `priority` (0–3), `search`, `perPage`,
`offset`, `sortBy`. The Weeek docs index describes `completed` as a
`boolean`, but see the probe below: the wire encoding is **`1`/`0`**, not
the strings `true`/`false`. There is also an `all: boolean` flag that, when
set, ignores `completed`; we do not expose `all` in I4.

> **Probe (2026-07-21) — `completed` filter encoding (bug #25 / #28,
> Bug 3).** Against the live API the `completed` filter is validated as a
> **Laravel boolean**: it accepts `1`/`0` and **rejects** the JS
> `String(bool)` form. `GET /tm/tasks?completed=true` and `?completed=false`
> both return **HTTP 422** with
> `{"completed":["The completed field must be true or false."]}`; the pre-fix
> serialization (`params.set("completed", String(args.completed))`) sent
> exactly that string, so the filter never worked — every filtered call
> surfaced as `weeek_invalid_response` (since I8 / #42 that same 422 surfaces
> as `weeek_validation_error`), not a silent no-op. `?completed=1`
> narrowed to completed tasks (0 in the sandbox workspace) and `?completed=0`
> to incomplete tasks (9) — distinct, correctly-narrowed sets, whereas the
> unfiltered baseline also returned 9. The param **name** `completed` is
> correct: `?isCompleted=true|false` (the response-body field name, fixed in
> #27) is **silently ignored** as a query filter — it returns the full list,
> identical to an unknown param such as `?bogusParam=true`. `listTasks` now
> serializes `completed` to `1`/`0`; the tool **input** field stays
> `completed: boolean` (agent-facing camelCase; the snake_case input rename is
> I8). The sandbox had no completed tasks, so only the `true → empty`
> direction was observed directly; the discriminator is `?completed=1` → 0
> vs. baseline → 9 (an ignored filter would return 9), which is conclusive.

Tool `weeek_list_tasks` exposes only the inputs that survive an arg-audit for
tenant-data echo (see I1-M3), and — since I8 — the filters a write workflow
needs to find the card it is about to act on: the two location ones (#48) plus
the assignee (#51). The input surface
is snake_case (D4/#41), the query parameters stay upstream camelCase; the
mapping lives in `listTasks` and is:

| Tool input | Query parameter | Type |
|---|---|---|
| `project_id` | `projectId` | int |
| `board_id` | `boardId` | int |
| `board_column_id` | `boardColumnId` | int |
| `assignee_id` | `userId` | UUID string (the rename is deliberate — see below) |
| `completed` | `completed` | Laravel bool, wire `1`/`0` (see above) |
| `offset` | `offset` | int |
| `per_page` | `perPage` | int |

The remaining documented filters (`day`, `search`, `type`, `priority`,
`sortBy`, `all`) stay out — the surface is bounded deliberately.

> **Probe (2026-07-22, #48) — the board / board-column filters.** Sandbox
> baseline: 11 tasks, of which #1 and #2 sit on board 1 / column 1 and a probe
> task (#53) was moved to board 1 / column 2. `?boardId=1` → `{1, 2, 53}`;
> `?boardColumnId=1` → `{1, 2}`; `?boardColumnId=2` → `{53}`;
> `?boardId=1&boardColumnId=2` → `{53}`. The filters **AND** with each other
> and with `projectId` / `completed` / `userId`
> (`?boardId=1&projectId=1&completed=0&userId=<uuid>` → `{1, 2}`). Column ids
> are unique across boards, so `boardColumnId` alone is already precise —
> `boardId` is not required alongside it.
>
> Failure mode worth knowing, because it differs from what an agent
> extrapolating from a "filter" would assume: an id that does not exist is
> **422**, not an empty page — `?boardId=99` →
> `{"boardId":["The selected board id is invalid."]}`, `?boardColumnId=99` →
> the matching column message, `?boardId=abc` → `"The board id must be an
> integer."`. All three surface as `weeek_validation_error` (#42). Tasks with
> no board (`boardId: null`, the default for a task filed without a location)
> are simply absent from any board-filtered page.

> **Probe (2026-07-23, #51) — `?userId=` matches ANY assignee.** The open
> question was whether the upstream filter reads the task's `userId` field
> (the primary assignee) or its `assignees` array; an agent given the wrong
> answer silently works the wrong queue, so this was settled by experiment
> rather than by reading the docs.
>
> Run in a sandbox workspace against a purpose-built task (`#34`,
> created and deleted by the probe; no pre-existing task was touched).
> A = the token owner's user id, B = a second workspace member's user id.
> `POST /tm/tasks/34/assignees {"assignees":["A","B"]}` → the task reads back
> `userId: A`, `assignees: [A, B]`: **the first UUID in the request becomes the
> primary**, the rest are secondary. The decisive call
> `GET /tm/tasks?userId=B` — B being the *secondary* assignee — **returned the
> task**. So does `?userId=A`. The filter therefore matches membership in
> `assignees`, not equality with `userId`, despite being named for the latter.
>
> Confirming checks, so the result is not a single-call artefact:
> `?userId=B&boardColumnId=11` (the probe's own column) → the task;
> `?userId=B&boardColumnId=10` → empty; `?userId=B&projectId=1` → the task —
> i.e. the assignee filter ANDs with the location filters, as board / column /
> project / completed already do with each other. A UUID that is no member of
> the workspace is a **422** (`{"userId":["The selected user id is
> invalid."]}`), not an empty page — the same failure mode as the two board
> filters, and the reason the tool input says so.
>
> One more thing worth knowing for a future assignee-write tool:
> `DELETE /tm/tasks/34/assignees {"assignees":["A"]}` (removing the primary)
> **promotes** the remaining assignee — the task then reads `userId: B`,
> `assignees: [B]`, and `?userId=A` no longer returns it. There is no
> assignee-less-but-still-assigned intermediate state.
>
> Cleanup: `DELETE /tm/tasks/34` returned `{"success":true}` and the task left
> the list (32 tasks, none titled `probe-48` surviving). One property of that
> delete is filed with the `DELETE /tm/tasks/{id}` write-up below, where it
> belongs, rather than here.

`outputSchema` for `weeek_list_tasks` carries
`{tasks: [{id, title, completed, projectId, priority, type}], hasMore, truncated}`.
`hasMore` (Weeek pagination) and `truncated` (I5c byte-budget gate) are
independent signals — see README.

## /tm/tasks/{id} (get one)

```jsonc
{
  "success": true,
  "task": {
    "id": <int>,
    "parentId": <int|null>,
    "title": "...",
    "description": "...|null",
    "duration": <int|null>,
    "overdue": <int>,
    "type": "action" | "meet" | "call",
    "isCompleted": <bool>,
    "userId": "<uuid>",
    "assignees": ["<uuid>", ...]
    // ... more fields (priority: number | null, locations[], …),
    // mirroring the list shape
  }
}
```

Probe (2026-05-13) confirmed `userId` is a **UUID string** (same
format as `/ws/members.id` and `/tm/projects.team[]`), and
`assignees` was an array of those same UUID strings (never a scalar)
in every probed task. The sandbox workspace had
only one member, so multi-assignee arrays could not be observed
directly; element type is asserted from the single-element samples
across all probed tasks plus the list shape. Session B re-confirmed
the single-member constraint (`/ws/members` returned `count=1`);
multi-element `assignees` capture stays unit-test-only until a
larger workspace is available. I7 promotes both fields to required
in the tool `outputSchema` (G3 BREAK → `0.2.0`).

> **Reconciliation (audit §5.2):** the OpenAPI spec declares `assignees`
> **nullable** (`{"type": ["array","null"]}`) and its own example shows
> `"userId": null` — cases the single-member probe never exercised, so
> "in every probed task" is not a guarantee. A documented-legal
> `assignees: null` currently makes `readAssigneeFields` throw
> `weeek_invalid_response` (tracked as **API-01** in the audit's fix
> table). `userId` is **absent from the spec's declared task schema**;
> the spec's `null` example is what backs the `z.string().nullable()`
> shape. See the read-surface
> audit (2026-07-15) §5.2.

I4 tool `weeek_get_task` accepts `{ id: number }`. The `id` is path-injected
via `String(id)` after the validator confirms it is a finite integer ≥ 1.
404s map to `weeek_not_found` via `unwrap.ts:codeForStatus`.

`outputSchema` carries
`{id, title, description, completed, projectId, priority, type, truncated}`.
On `truncated:true`, `description` ends with the marker `…[truncated]`
(I5c — only `description` is variable-length on TaskDetail).

## /tm/tasks/{id}/complete and /tm/tasks/{id}/un-complete (write)

The two dedicated completion routes, and the transport behind
`weeek_complete_task` (I8, #43).

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/tm/tasks/{id}/complete` | none | `{ "success": true }` |
| POST | `/tm/tasks/{id}/un-complete` | none | `{ "success": true }` |

Two things follow from that response shape:

1. **There is no task echo.** Unlike `PUT /tm/tasks/{id}` (the `move_task` /
   `update_task` transport, probe #12), these routes answer with the bare
   envelope. `weeek_complete_task` therefore issues a second call — a plain
   `getTask` read-back — and returns *that* as the resulting task. The
   read-back is authoritative: if the flag did not land, the agent sees the
   real state rather than an echo of its own request.
2. **`parseWeeekResponse` does not fit.** It requires a resource key on the
   envelope. `parseWeeekAck` (`src/weeek/unwrap.ts`) validates the same status
   → `WeeekErrorCode` mapping and the same `success: true` requirement, with no
   key — a `success: false` 200 is `weeek_invalid_response`, never a silent
   no-op.

> **Probe (2026-07-22, non-mutating) — route existence and spelling.** The
> hyphenated `un-complete` is easy to get wrong, and a wrong path is a live
> 404 that unit tests cannot catch. Discriminated without writing anything by
> sending `GET` (the wrong method) to each candidate and reading the status:
> `/tm/tasks/1/complete` → **405, `allow: POST`**;
> `/tm/tasks/1/un-complete` → **405, `allow: POST`**;
> `/tm/tasks/1/uncomplete` → **404**; a nonsense sibling route → **404**.
> A route that exists answers 405 for the wrong verb; one that does not
> answers 404. So both routes exist, both are POST-only, and the spelling is
> `un-complete`.
>
> **Not probed:** whether `PUT /tm/tasks/{id}` also accepts a completion field
> (which would collapse the two legs into one). It was not chosen even as a
> candidate: a Weeek `PUT` accepts an unknown field with a 200 and ignores it
> (the `customFields`-array trap, probe #12), so a wrong guess there fails
> silently, whereas these routes are documented for exactly this operation.

## /tm/tasks/{id} (update — the write transport)

`PUT /tm/tasks/{id}` is the general task-update endpoint and the transport
behind `weeek_move_task` (I8, #44). Unlike the completion routes above it
answers with the **full updated task** under the usual `task` envelope key, so
a write returns what a read returns and no follow-up call is needed.

| Body | Effect | Probe |
|---|---|---|
| `{ "boardColumnId": <int> }` | Same-board column change — i.e. a **status** change | #12: 200, `boardColumnId` + `locations[]` reflect it |
| `{ "boardId": <int>, "boardColumnId": <int on that board> }` | **Cross-board re-parent** | #12: 200, re-parents (NOT a 4xx); `boardId`, `boardColumnId`, `locations[0]` all update |

The deprecated dedicated endpoints `POST /tm/tasks/{id}/board` and
`POST /tm/tasks/{id}/board-column` still function, but answer `{success:true}`
(no task echo) and were deprecated on 2025-05-18 — `PUT` is preferred for both
modes: one call, full echo, cross-board capable.

> **Liability (API-03).** The `boardId` / `boardColumnId` body parameters this
> write uses were themselves deprecated on 2025-05-18 in favour of a
> `locations[]` structure, with a grace period that expired around 2025-06-17.
> The live API still honours them; the replacement **write** shape has never
> been probed. We ship on the parameters observed to work and track the
> migration rather than guessing at a shape we have not seen answer 200 — the
> `customFields`-array trap (probe #12) is what guessing costs here. This
> migration is tracked as a known risk.
>
> **Unprobed:** `PUT` with `boardId` and no column. The tool cannot express it
> (`board_column_id` is required), so the question stays open by design rather
> than by omission.

### The field-edit surface (probe #46, 2026-07-22)

`weeek_update_task` (#46) writes to the same `PUT`. Every candidate field was
sent on its own scratch task and then confirmed by a re-`GET` — the echo alone
proves nothing, since an echo can be a synthesis of the request. `allow` on the
path is `GET,HEAD,PUT,DELETE`: there is **no `PATCH`**.

| Body field | Verdict | Observed |
|---|---|---|
| `title` | **editable** | Persists. An **empty string is accepted (200) and stored as `null`** — a blanked card. The tool schema's `min(1)` is the only guard, exactly as on create. |
| `priority` | **editable, clearable** | Persists, `0` included; explicit `null` unsets it (probe #46f). |
| `type` | **editable, NOT clearable** | `"meet"` persisted; `null` is ignored — an enum with a default has no "unset" state (probe #46f). |
| `dueDate` | **editable, clearable** | `"2026-12-30"` persisted; explicit `null` — and `""` — drops the due date (probe #46f). |
| `description` | **ACCEPTED AND IGNORED** | 200, and the stored description is unchanged — a pre-existing value survives untouched, an absent one stays `null`. Not clobbered; simply not written. |
| `assignees` | **ACCEPTED AND IGNORED** | 200, `assignees` stays `[]`. Has its own route — see below. |
| `isCompleted` | **ACCEPTED AND IGNORED** | 200, flag unchanged. The dedicated completion routes own it (#43). |
| *(unknown field)* | accepted and ignored | 200, no error — the `customFields`-array trap (probe #12) reproduced on the update path. |

Three consequences the tool acts on:

- **An un-named field is left alone.** Updating `title` on a task with a
  description and a priority left both intact. This is what makes "only the
  fields you name change" a property of the API and not just of our request
  builder — but it holds only while we send no key for an un-named field, which
  is why the body is built key-by-key rather than spread.
- **An empty body is a 200 no-op.** `PUT {}` answers 200 with the unchanged
  task. A tool that forwarded it would burn a live round-trip and hand the
  agent a success. `weeek_update_task` refuses it locally and issues **no
  request at all**; the refusal is raised at the transport seam
  (`WeeekEmptyUpdateError`), not in the tool, so it cannot be bypassed.
- **A nonexistent task id answers 404 with an HTML body**, not JSON. The status
  drives the mapping (`weeek_not_found`), so the unparseable body costs
  nothing — worth knowing before someone "fixes" the client to require JSON.
- **`null` clears — on two of the four fields.** Probed separately (#46f)
  because the first pass only asked whether a field could be *set*, which
  leaves "can a value be taken back off?" unanswered — and a tool that can set
  a due date but never remove one is a capability gap of our own making, not
  the API's. Results: `{"dueDate": null}` and `{"priority": null}` both clear
  (`""` clears a due date too); `{"type": null}` is ignored. So `null` is a
  supplied value with a meaning, and the request builder must test
  `!== undefined`, never truthiness — the same discipline `priority: 0`
  already needed, for a second reason.

  `title` is deliberately **not** nullable in the tool schema even though the
  API accepts it: a null title blanks the card, which is the create-side trap
  again rather than a clear.

> **`description` is not editable through Public API v1.** This is the single
> most consequential finding of the probe, and it is why `weeek_update_task`
> has four fields where the ticket assumed six. Everything tried: `description`
> plain, `description` as HTML (`<p>…</p>`), `description` alongside a `title`
> that *did* land in the same body, `content`, `text`, `descriptionHtml`,
> `body`, `desc`; `PATCH /tm/tasks/{id}` → **405**; `GET /tm/tasks/{id}/description`
> → **404** (no dedicated route, where `/complete` and `/assignees` both answer
> 405 and therefore exist). A description can be set **at create time** (#45)
> and never changed afterwards. Offering the field would have shipped a tool
> that reports success for an edit that never happened.

### /tm/tasks/{id}/assignees — a route, and a different shape (probe #46)

`assignees` is ignored on the `PUT`, but the differential 405-vs-404 sweep
turned up a dedicated route that does work:

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/tm/tasks/{id}/assignees` | `{"assignees": ["<uuid>", …]}` | `{"success": true}` (ack only, no task echo) |
| DELETE | `/tm/tasks/{id}/assignees` | `{"assignees": ["<uuid>", …]}` | `{"success": true}` |

`GET` on the path answers **405 `allow: POST, DELETE`**. Observed semantics:

- POST assigns the named members; `userId` (the primary assignee) is filled
  from the list. Re-POSTing a member already on the task is a no-op, not a
  duplicate.
- DELETE removes the named members; removing one that is not assigned is a
  200 no-op.
- **`{"assignees": []}` is a 422** on both verbs (`"The field is required."`),
  and an unknown or malformed UUID is a 422 naming `assignees.0`.
- POST against a nonexistent task id is a 404.

This is **add/remove, not set**: the empty list — "unassign everyone" — is not
expressible, and swapping assignee A for B is two calls. That is a different
tool's shape, not a field of `weeek_update_task`, so #46 leaves it out and it
is tracked as a follow-up rather than half-built here.

### The custom-fields write: an array to read, a MAP to write (probe #12)

`weeek_set_task_mr_link` (#47) writes to the same `PUT`, under a body key
disjoint from every other write tool's. **The read shape and the write shape
are not the same shape**, and the difference is silent:

| Direction | Shape | Result |
|---|---|---|
| READ (`GET /tm/tasks/{id}`) | `customFields: [{id, name, type, value}]` — an **array** | how a task echoes its fields back |
| WRITE (`PUT /tm/tasks/{id}`) | `{"customFields": {"<field-uuid>": "<value>"}}` — a **MAP keyed by field id** | value is stored |
| WRITE, array form | `{"customFields": [{"id": "<uuid>", "value": "…"}]}` | **200 — and the value is silently discarded**; the field stays `null` |

> **This is the sharpest trap in I8.** The array is the shape a reader
> naturally reproduces, the API accepts it, and the status code is
> indistinguishable from a successful write. The implementation therefore
> builds the map at one place
> (`setTaskMrLink` in `src/weeek/endpoints/tasksWrite.ts`, commented on the
> line that builds it) and the test asserts on the **recorded request body**,
> not on a 200 — a status-only assertion would pass against a tool that writes
> nothing at all. A mock can prove the bytes we send and structurally cannot
> prove Weeek stored them; the write → re-`GET` → value-present round-trip
> ADR 0005 gates on belongs to the live write-cycle harness (#49).

Three further facts the tool is built on:

- **The field id is a UUID string**, not the integer used for task / project /
  board / column ids. It is the map key, and the tool's `custom_field_id`
  input is typed `z.string().uuid()` accordingly.
- **There is no dedicated task-custom-field route.**
  `PUT` / `POST /tm/tasks/{id}/custom-fields[/…]` → **404**. Every value write
  goes through the task `PUT` body.
- **A `link` (or `text`) field takes a plain string** as its value — no
  `{value: …}` wrapper.

#### /tm/custom-fields (list — internal only)

| Method | Path | Envelope key | Notes |
|---|---|---|---|
| GET | `/tm/custom-fields` | `data` | `{success:true, data:[{id, name, type}, …]}` — probe #12. The **published spec documents this as an empty object** (`{"type":"object","properties":{}}`) with no `/{id}` sibling; the live API disagrees, which is what makes by-name resolution possible at all. Empty `data: []` on a tenant with no fields. |

Read **internally only**, by `weeek_set_task_mr_link`'s name → id resolution.
No listing tool is exposed and `POST /tm/custom-fields` (field creation, which
exists and accepts `type: "link"`) is **never called from `src/**`** —
custom-field CRUD was declined in the scope lock (#9), so the tool writes into
an existing field or errors (ADR 0005 §3–§4). The one caller anywhere in the
repository is the live write-cycle harness, below.

> **The whole CRUD surface exists upstream** (method probe, 2026-07-23): a
> disallowed verb on `/tm/custom-fields` answers `405 allow: GET, HEAD, POST`
> and on `/tm/custom-fields/{id}` answers `405 allow: PUT, DELETE` — so the
> spec's "no `/{id}` sibling" is wrong here too.
>
> `POST /tm/custom-fields {"name": …, "type": "link"}` answers 2xx and the
> field appears in the listing (live write-cycle run, 2026-07-23); the create
> response's own shape is **unprobed** — the harness re-lists instead of
> reading it. `DELETE /tm/custom-fields/{id}` removes it, and unlike a task
> delete the removal is total: the field is gone from the listing, and the
> tenant was verified back at `data: []`.
>
> **Nothing in `src/**` calls any of it.** The only caller is the live
> write-cycle harness (#49), which provisions the MR-link field its round-trip
> needs when the sandbox has none and deletes it again in cleanup — test code
> holding a capability the server deliberately does not (the same split as the
> raw task `DELETE`). A field that already exists is used as-is and never
> deleted: it belongs to the operator.

The names matched when the caller supplies neither an id nor a name, compared
case-insensitively after trimming (`MR_LINK_FIELD_NAMES` in
`src/weeek/endpoints/tasksWrite.ts` — the constant the tool description quotes,
so the published list and the matched list cannot drift):

> `MR link` · `MR URL` · `Merge request` · `Merge request URL` · `PR link` ·
> `Pull request`

A name match alone does not resolve: the field's `type` must also be one that
holds a plain string (`link` or `text`). A `number`-typed field someone called
"MR link" would take the URL and, at best, 422 — at worst answer 200 and drop
it, the same trap one level down. The filter's own failure (a link-ish field
of a type spelling we have never seen) is loud and carries a remedy;
`custom_field_id` skips the listing, and therefore this filter, entirely.

Two matches is an **error**, not a pick by list order: writing to whichever
field happened to be listed first would be indistinguishable from a correct
resolution. `custom_field_id` settles it.

> **Plan-tier caveat.** The probe tenant permitted custom fields; real tenants
> may gate them by plan. That degrades to the ladder's terminal rung — a clean
> tool error saying no MR-link field is defined (and naming the plan as a
> possible reason) — not to a crash and not to a silent no-op. A refusal on the
> listing itself (e.g. 403) surfaces as `weeek_forbidden` and issues no write:
> reporting "no field is defined" for a workspace that merely would not show
> its fields would be worse than the failure.

## /tm/tasks (create — the write transport)

`POST /tm/tasks` is the create endpoint behind `weeek_create_task` (I8, #45) —
the same path the list read uses, under the write verb. Like the update `PUT`
it answers with the **full new task** under the `task` envelope key, so the
caller gets the new id without a read-back.

> **Probe (2026-07-22, #45) — the create surface, field by field.** Run against
> a live workspace because a Weeek write accepts an unrecognised field with a
> **200 and silently ignores it** (the `customFields`-array trap, probe #12):
> documentation alone cannot distinguish "supported" from "accepted and
> discarded". Each field below was sent in a create and then confirmed by a
> re-`GET` of the created task — the echo alone is not proof, since an echo can
> be a synthesis of the request.

| Body field | Type | Verdict | Observed |
|---|---|---|---|
| `title` | string | **Not required by the API** | Omitted → 200, task stored with `title: null` |
| `projectId` | int | **Not required by the API** | Omitted → 200, task stored with `projectId: null` and no `locations[]`; a nonexistent id → **422** `{"success":false,"errors":{"projectId":["The selected project id is invalid."]}}` |
| `description` | string | supported | Persists — but Weeek stores it as **HTML**: a plain line comes back as `<p>…</p>` |
| `type` | enum `action`/`meet`/`call` | supported | `"call"` persisted; default when omitted is `"action"` |
| `priority` | int | supported | `2` persisted; default when omitted is `null` (unprioritised — *not* `0`) |
| `boardId` | int | supported, **standalone** | Alone → task lands in that board's **first** column (`boardColumnId: 1` of board 1) |
| `boardColumnId` | int | supported, **standalone** | Alone → 200; the board is derived from the column (`boardId` filled in, `locations[0]` reflects both) |
| `assignees` | string[] (UUIDs) | supported | Persisted, **and** the first element becomes the task's primary `userId` |
| `dueDate` | `Y-m-d` string | supported | `"2026-12-31"` persisted; `dueDateTime` stays `null` |

Two consequences the tool acts on:

- **The tool's required fields are stricter than the API's.** `title` and
  `project_id` are required in the input schema because the API will otherwise
  cheerfully store an untitled card, or a task belonging to no project at all,
  neither of which anyone will find again. The schema is the only guard, so it
  rejects a whitespace-only title too.
- **Board and column are independent optionals here**, unlike
  `weeek_move_task`, where a column is required and a board alone is not
  expressible. On create each resolves alone, so the schema permits either.

> **Liability (API-03).** `projectId` as a create-body parameter carries the
> same 2025-05-18 deprecation as the update path's `boardId` /
> `boardColumnId`, in favour of the `locations[]` structure. The live API still
> honours it (200, and `locations[0].projectId` reflects the value); the
> replacement **write** shape has never been seen to answer 200. Same call as
> `moveTask` makes: ship what demonstrably works, track the migration.
>
> **Unprobed:** `locations[]` as a create-body parameter; `startDate`;
> `tags`; `parentId`; `customFields` on create (the update path's map shape is
> probe #12's finding, and `set_task_mr_link` (#47) owns it).

> **`DELETE /tm/tasks/{id}` EXISTS** (probe #45, 2026-07-22) — correcting the
> roadmap's standing assumption that Weeek API v1 has no task deletion. A
> nonexistent id answers **404 `{"message":"Record not found"}`**, not the
> `405 allow: …` a missing method produces (the same differential #43 used for
> `/complete` vs `/uncomplete`), and the six tasks this probe created were
> subsequently removed with it — 200 `{"success":true}` each, tenant verified
> back at baseline.
>
> **The delete is a soft one** (probe #51, 2026-07-23): after a successful
> `DELETE`, the task is gone from `GET /tm/tasks` but a direct
> `GET /tm/tasks/{id}` still resolves, with `isDeleted: true`. So "removal" here
> means removal from every listing an agent can reach, not erasure — worth
> knowing for an operator cleaning up after a probe, and it narrows the
> "irreversible" wording below without changing what it concludes.
>
> This changes nothing about the tool surface: **no delete tool is in scope**,
> now on the same grounds as before minus the feasibility one — the removal is
> not a capability to hand an agent (ADR 0004): it is irreversible through this
> API even if the row survives behind a flag. `WeeekMethod`
> deliberately cannot express `DELETE` so the client could not issue one. It
> does change #49: the live write-cycle harness can clean up after itself for
> real, instead of falling back to "complete the task and mark it with a
> run-identifying title so a sandbox does not silently accumulate fixtures".

## /tm/boards (list)

```jsonc
{
  "success": true,
  "boards": [
    {
      "id": <int>,
      "name": "...",
      "projectId": <int>,
      "isPrivate": <bool>
    }
  ]
}
```

`projectId` is **required** as a query parameter. `GET /tm/boards`
without it returns `HTTP 422` with body
`{"success": false, "message": "The field is required.",
"errors": {"projectId": ["The field is required."]}}`. The I7 tool
`weeek_list_boards { projectId }` enforces this at the Zod input
layer so the agent never sees the upstream 422.

The element field is `name` (string), **not** `title` — differs
from `/tm/projects` and `/tm/tasks` which both use `title`. This is
the only `tm/` resource probed so far that uses `name` for its
human-readable label; mirror this in the tool's `outputSchema` key
to avoid silent renaming.

Pagination: no markers (`hasMore` / `offset` / `total` absent).
Probe (2026-05-13) returned the full list in a single response.
Treat as "returns all boards for the project" until confirmed
otherwise.

`outputSchema` for `weeek_list_boards` carries
`{boards: [{id, name, projectId, isPrivate}], truncated: boolean}`.
The full upstream shape is already minimal; `truncated` is the I5c
byte-budget signal.

## /tm/board-columns (list)

```jsonc
{
  "success": true,
  "boardColumns": [
    {
      "id": <int>,
      "name": "...",
      "boardId": <int>
    }
  ]
}
```

Path is `/tm/board-columns?boardId=<int>` — hyphenated, **not**
`/tm/boards/{boardId}/columns` as one might guess from REST
conventions (that path returns the SPA's generic 404 HTML page).
`boardId` is a required query parameter (mirrors `/tm/boards`
requiring `projectId`).

> **Reconciliation (audit §5.4):** the spec marks `boardId`
> `required: false`. The "required" claim above is an inference by
> analogy from `/tm/boards` — the probe tested an *invalid* id (422),
> not a *missing* one. Our Zod gate enforces `boardId` regardless;
> whether a no-query call returns all workspace columns is unsettled
> (one tokenless probe would settle it). See the read-surface
> audit (2026-07-15) §5.4
> (tracked as API-06).

Envelope key is `boardColumns` (camelCase, plural).

No `order` / `sortOrder` / `position` field is exposed in the
element shape. Array ordering is the only sort signal — preserve
the upstream array order through the tool's output verbatim. If
Weeek later adds an explicit ordering field, revisit
`weeek_list_board_columns` and the I7 plan.

Pagination: not documented. Probe (2026-05-13) returned 3 columns
in a single response. Treat as "returns all columns for the
board".

**Unknown `boardId` → HTTP 422** with body `{"success":false,
"message":"The selected board id is invalid.",
"errors":{"boardId":["The selected board id is invalid."]}}` —
mirrors `/tm/boards` without `projectId` (probe 2026-05-13,
session B). Since I8 (#42) `unwrap.ts:codeForStatus` maps 400 and
422 to `weeek_validation_error`, so the tool surfaces this as
`weeek_list_board_columns failed (weeek_validation_error): …` —
"the id you sent is wrong", not the old catch-all
`weeek_invalid_response` ("the API drifted"). See
[`errors.md`](errors.md).

`outputSchema` for `weeek_list_board_columns` carries
`{boardColumns: [{id, name, boardId}], truncated: boolean}`. The
full upstream shape is already minimal; `truncated` is the I5c
byte-budget signal.

## /ws/members (list)

```jsonc
{
  "success": true,
  "members": [
    {
      "id": "<string>",
      "email": "...",
      "logo": "...|null",
      "firstName": "...|null",
      "lastName": "...|null",
      "middleName": "...|null",
      "position": "...",
      "timeZone": "..."
    }
  ]
}
```

Note the `id` is **string** (per the indexed shape), unlike most other
resources. Pagination not documented — returns the full member list.

`outputSchema` for `weeek_list_members` carries
`{ members: [{id, email, firstName, lastName}], truncated: boolean }`.
`position`, `timeZone`, `logo`, `middleName` are dropped to keep the contract
narrow. `truncated` is the I5c byte-budget signal.

## /ws/tags (list)

```jsonc
{
  "success": true,
  "tags": [
    { "id": <int>, "title": "...", "color": "..." }
  ]
}
```

`id` is integer ≥ 1. No pagination documented.

`outputSchema` for `weeek_list_tags` carries
`{ tags: [{id, title, color}], truncated: boolean }` — the full upstream
shape is already minimal; `truncated` is the I5c byte-budget signal.

## Open questions / TODO before merging I4

- **Operator step:** run all five new tools through the Inspector with a real
  `WEEEK_ACCESS_TOKEN` and capture the actual response shape. If any field
  declared in our `outputSchema` is absent from the live payload, the SDK
  will reject `structuredContent` and the tool will surface as `isError`.
  This catches the kind of drift that bit `weeek_get_me` between I3 and I4.
- **`name` derivation:** if Weeek ever adds a real `name` field on `/user/me`,
  prefer it over the `firstName + lastName` derivation. Encoded as a `??`
  fallback in `endpoints.ts` so the migration is a no-op.
- **Pagination on lists other than tasks:** if Weeek begins returning
  `hasMore` on `/tm/projects`, `/ws/members`, or `/ws/tags`, mirror the
  `weeek_list_tasks` pagination shape on those tools.
