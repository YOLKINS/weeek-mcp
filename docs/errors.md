# Error codes

Every Weeek-backed tool (`weeek_*`) fails the same way: `isError: true` with a
single `text` block of the shape

```
<tool> failed (<weeek_code>): <one English sentence>
```

The `weeek_<code>` token is the stable, machine-greppable contract — the
English sentence after it may be reworded, translated, or lengthened; the code
will not change meaning. Agents should branch on the code, never on the prose.

Two rules hold for **every** row in the table below:

- **Errors are tool-level, never protocol-level.** A `WeeekError` is returned
  as `isError: true` content (INVARIANT-6); it is never thrown as an MCP
  protocol error, so a failed call never poisons the session.
- **Nothing from the wire is echoed.** The sentence is derived from the code
  alone (`src/weeek/humanMessage.ts`). Response bodies, `WeeekError.message`,
  `err.cause`, request bodies, and the `Authorization` header never reach the
  error text or the logs (INVARIANT-2, INVARIANT-7, INVARIANT-9).

## The nine codes

| Code | Produced by | Retry? | What to do |
|---|---|---|---|
| `weeek_unauthorized` | HTTP 401 | **No** — a retry sends the same rejected token | Operator: `WEEEK_ACCESS_TOKEN` is missing, expired, or copied with surrounding whitespace. Re-issue it at <https://app.weeek.net/ws/_/settings/apps/api>. |
| `weeek_forbidden` | HTTP 403 | **No** | The token is valid but the workspace role lacks permission for that resource. Operator: raise the role, or leave the resource alone. |
| `weeek_not_found` | HTTP 404 | **No** | The id does not exist in the configured workspace (or was deleted). Agent: re-list the parent collection and pick a live id. |
| `weeek_validation_error` | HTTP 400, HTTP 422 — **and** a request this server refused to send at all (see below) | **Only after fixing the arguments** | The request carried a value Weeek rejected — a bad id, a missing required field, a wrong type — or was rejected locally before any call. Agent: correct the arguments and re-issue. |
| `weeek_rate_limited` | HTTP 429 | **Yes**, after a delay | Back off, then retry; reduce call frequency (e.g. fewer list calls with a smaller page size). |
| `weeek_server_error` | HTTP 5xx | **Yes**, shortly | Upstream fault. If it persists, check Weeek's status page — nothing local will fix it. |
| `weeek_network` | `fetch` rejected (DNS, TLS, connection refused) | **Yes** | The host could not reach `api.weeek.net`. Operator: check connectivity and `WEEEK_BASE_URL`. |
| `weeek_timeout` | The request exceeded `WEEEK_TIMEOUT_MS` (`AbortError`) | **Yes**, once | Retry; if a large workspace times out repeatedly, raise `WEEEK_TIMEOUT_MS`. |
| `weeek_invalid_response` | 2xx whose body is not JSON, is not an object, lacks `success: true`, or lacks the expected envelope key; any other non-2xx status not listed above | **Once** | If it persists, the upstream API contract has drifted — file an issue. This is the "the API sent something unexpected" code. |

Retry is **agent-side by design** (RETRO-01): the server never retries an
upstream call and `WeeekError` carries no `retryable` flag. The code is the
contract; the agent decides.

## `weeek_validation_error` vs `weeek_invalid_response`

These two are easy to confuse and mean opposite things:

- **`weeek_validation_error` — you sent something wrong.** Re-issuing the
  identical call will fail identically. Change the arguments.
- **`weeek_invalid_response` — the API sent something unexpected.** The
  arguments may be perfect; the fix is upstream (or in this server's parser).

Both HTTP **400** and HTTP **422** map to `weeek_validation_error`. 422 is
included because the live API demonstrably uses it for per-field request
validation rather than for drift — bug #28 observed
`{"completed":["The completed field must be true or false."]}` returned on a
422, and an unknown `board_id` on `/tm/board-columns` returns 422 the same way.
Before I8 those fell into the `weeek_invalid_response` catch-all, which told an
agent *the API drifted* when in fact *the agent sent a bad value*.

This applies to reads as well as writes: a `weeek_list_boards` call with a
stale project id now returns `weeek_validation_error`.

### The third producer: a request that was never sent (I8, #46)

`weeek_validation_error` also covers arguments **this server** rejects before
calling Weeek — a `WeeekRequestNotSentError` (`src/weeek/types.ts`). There are
three, and none of them puts a byte on the wire:

| Refusal | Tool | Why it is refused locally |
|---|---|---|
| No field named to change | `weeek_update_task` (#46) | `PUT` with an empty body is a **200 no-op** upstream (probe #46), so forwarding it would hand the agent a success for an edit that never happened. |
| No MR-link custom field resolved | `weeek_set_task_mr_link` (#47) | The write needs a field **id** as its body key. Without one there is nothing to write into — and no field is ever auto-created (ADR 0005 §4). |
| More than one custom field matched the name | `weeek_set_task_mr_link` (#47) | Picking one by list order would be a coin flip indistinguishable from a correct resolution. |

The last two are the terminal rung of the MR-link field ladder. The tool's
error text carries the remedy — name the field with `custom_field_name` or its
UUID with `custom_field_id`, or have an operator create one — and deliberately
**does not name the fields the workspace holds**: the resolver has just read a
list of them, and those names are tenant data (INVARIANT-2).

The code is the same because the agent's remedy is the same — "you sent
something wrong; change the arguments" — and a tenth code would ripple through
the compile-time-exhaustive error matrix for one local guard. What differs is
the **sentence**: `humanMessage` branches on the error class so a locally
refused call never claims "Weeek rejected the request (HTTP 400/422)" about an
exchange that did not happen. Two consequences worth knowing:

- **`status` is absent**, since there was no HTTP response to carry one. The
  `{ code, status }` warn ctx logs `status: undefined`.
- **Nothing was mutated.** This is the one `weeek_validation_error` an agent
  can be certain left the workspace untouched.

Note that the per-field validation body Weeek returns
(`{"errors":{"title":["The title field is required."]}}`) contains the values
the agent submitted, so it is **never** surfaced — not in the error text, not
in the logs. The code tells the agent *which* kind of mistake it made; the tool
input schema tells it what the field should have been.

## Field-level drift does not produce an error at all

Since I7.5 (ADR 0003) a single
drifted *inner field* no longer fails a call: it degrades to a schema-valid
default (`""` / `0` / `false` / `null` / `[]`) and the call succeeds, with one
de-duplicated `warn` line on stderr naming the field (never its value). Only
the **envelope** layer is strict — a missing `success: true` or a missing
top-level key still raises `weeek_invalid_response`, because that means "this
is not the API I think I'm talking to".

So an agent seeing `weeek_invalid_response` is looking at a structural break,
not a cosmetic rename.

## Where this lives in the code

| Concern | File |
|---|---|
| The code union | `src/weeek/types.ts` (`WeeekErrorCode`) |
| HTTP status → code | `src/weeek/unwrap.ts` (`codeForStatus`) |
| Code → English sentence | `src/weeek/humanMessage.ts` |
| Transport-level codes (`weeek_network` / `weeek_timeout`) | `src/weeek/client.ts` |

The taxonomy is pinned from both ends: `tests/invariants/error-matrix.test.ts`
drives every code × every Weeek tool (81 cells) and asserts the `isError` shape,
the `<tool> failed (<code>): ` prefix, the sentence, and a `{ code, status }`
log context with no other keys. Both that matrix and the sentence table in
`tests/weeek/humanMessage.test.ts` are compile-time exhaustive, so a tenth code
cannot be added without a sentence, its matrix cells, and a row in this file.
