# CLAUDE.md — guide for AI coding agents working on `weeek-mcp`

This file is the entry point for AI agents (Claude Code, Cursor, etc.)
operating on this repository. Humans should read [`README.md`](README.md)
first; this is the agent-facing contract on top of it.

---

## What this is

A local read-only-by-default MCP server for [Weeek](https://weeek.net/),
talking to AI clients over stdio via `@modelcontextprotocol/sdk`.

**The surface is 10 / 15, and both counts are pinned literally.** Ten
**read** tools — `ping`, `weeek_get_me`, `weeek_list_projects`,
`weeek_get_project`, `weeek_list_tasks`, `weeek_get_task`,
`weeek_list_members`, `weeek_list_tags`, `weeek_list_boards`,
`weeek_list_board_columns` — are what a default install exposes. Five
**write** tools — `weeek_complete_task`, `weeek_move_task`,
`weeek_create_task`, `weeek_update_task`, `weeek_set_task_mr_link` —
carry `readOnly: false` in the registry and appear only under
`READ_ONLY=false`, taking `tools/list` to 15.

**The write set is closed.** A sixth write tool is a new increment with
its own scope call, not an addition to this one. Adding or removing any
tool means changing a literal count in `tests/tools/registry.test.ts`
and `tests/invariants/tools-list-wire.test.ts` (and
`tests/helpers/toolNames.ts`, the single copy of the names) — in the
same PR. That is deliberate: a structural assertion cannot tell "we
shipped the tools we planned" from "we shipped fewer and the helper list
agrees".

---

## Tech stack pinning

Pinned for a reason. Do **not** bump any of these without writing the
rationale into the bump commit / PR first.

- `@modelcontextprotocol/sdk` — `^1.29`. Do not jump to a v2 alpha
  without a dedicated RFC; we depend on the 1.x `McpServer` /
  `StdioServerTransport` surface and the 1.x `tools/list` registration
  shape.
- `zod` — `^3.23.8`. Do not upgrade to v4: the SDK turns our zod schemas
  into every tool's `inputSchema` and `outputSchema`, so a zod major is a
  `tools/list` wire change, not an implementation detail. Re-open when
  the SDK line itself moves.
- `typescript` — `^6.0.3`. Do not jump to TS 7: `typescript-eslint`
  `^8.65` declares `typescript: >=4.8.4 <6.1.0`, so TS 7 takes the linter
  — and therefore INVARIANT-1's enforcement — out with it.
- `vitest` — `^4.1`. Every coverage floor in `vitest.config.ts` must stay
  put: a floor that moves is a decision, never a migration artefact. (v4's
  v8 provider remaps through the AST, so coverage numbers are not
  comparable across the v3→v4 boundary.)
- `eslint` — `^10.7` with `typescript-eslint` `^8.65`. `no-console` here
  is what enforces INVARIANT-1 — verify the rule still fires after any
  linter bump.
- `@types/node` — `^25.9`. Tracks the newest Node release line, not our
  floor: the compiler sees APIs Node 20 does not have, so the **CI
  matrix**, not the type checker, is what defends `engines.node`.
- Node — `>=20`. CI matrix runs Node 20 + 22.

Targeted MCP protocol version: `2025-06-18`. The SDK auto-negotiates the
session version from the client's offer; re-verify the target on every
SDK bump.

---

## MCP invariants (do not break — even temporarily)

Enforced by tests (mostly under `tests/invariants/`). If a change breaks
one, the right move is almost always to fix the change, not the
invariant. The numbers are a contract — tests and `CONTRIBUTING.md`
reference them by number, so keep them stable.

- **INVARIANT-1 — stdout owned by the SDK.** `process.stdout` is the
  JSON-RPC channel; no `console.log` / `process.stdout.write` anywhere in
  `src/**`. A single stray byte corrupts every client's parser. Enforced
  by ESLint `no-console` + `registry-smoke.test.ts`.
- **INVARIANT-2 — Authorization / request body never logged.** The logger
  (`src/logging/logger.ts`) redacts recursively; never log `err.message`
  from a Weeek call. Enforced by `tests/logging/` + `mcp.test.ts`.
- **INVARIANT-3 — every tool has `outputSchema`.** Clients use it to
  populate `structuredContent`; document every nullable field. Enforced by
  `mcp.test.ts`.
- **INVARIANT-4 — every tool has all four `annotations`**
  (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).
  A missing hint makes clients fall back to destructive defaults. Enforced
  by `mcp.test.ts`.
- **INVARIANT-5 — `truncated: bool` in list / detail outputs.** Every list
  tool + `weeek_get_task` + `weeek_get_project` (and the five writes, which
  return the task-detail shape) declare and emit `truncated` as a stable
  signal. Enforced by `mcp.test.ts`.
- **INVARIANT-6 — handlers never throw.** Tools return
  `{ isError: true, content: [...] }` on `WeeekError`; throwing surfaces as
  an MCP protocol error and corrupts the agent's mental model. Enforced by
  the per-tool error-path tests under `tests/tools/`.
- **INVARIANT-7 — `humanMessage(err)` in `content[0].text`.** Tool errors
  render as `<tool> failed (<weeek_code>): <english sentence>` via
  `src/weeek/humanMessage.ts`; never echo `err.message` / `err.cause` /
  response bodies. Enforced by `mcp.test.ts`.
- **INVARIANT-8 — an alias / deprecation env warn carries the variable
  name only, never its value.** Governs future aliases (there is no live
  alias today). The one env warn the server still emits —
  `unknown tool in ENABLED_TOOLS` — logs a value on purpose, so the
  operator gets the misspelled name back. Enforced by
  `tests/config/env.test.ts`.
- **INVARIANT-9 — no error-text or logger-ctx leak.** Error
  `content[0].text` never echoes `err.message` fragments; `logger.warn`
  ctx is `{ code, status }` only, never `title` / `description` / `email` /
  payload. Defends INVARIANT-2 from the consumer side. Enforced by
  `mcp.test.ts`.
- **INVARIANT-10 — registry readOnly tripwire.** A tool registered under
  `READ_ONLY=true` must carry `annotations.readOnlyHint: true` — the
  registry's `readOnly` flag and the tool's annotation must move together.
  Guards the read set. Enforced by `mcp.test.ts`.
- **INVARIANT-11 — stdio cleanliness on startup.** A spawned
  `dist/index.js` (placeholder token) writes zero bytes to stdout in the
  first 500 ms and emits `"msg":"mcp server started"` on stderr — under the
  default, under `READ_ONLY=false`, and under the single-write-tool combo.
  Enforced by `registry-smoke.test.ts`.
- **INVARIANT-12 — write tools advertise `readOnlyHint: false`.** The
  converse of INVARIANT-10: every registry entry with `readOnly: false`
  carries `annotations.readOnlyHint: false`. The test derives the write set
  from the gate itself, not a hand-written list. Enforced by `mcp.test.ts`.
- **INVARIANT-13 — every tool input is snake_case** (`^[a-z][a-z0-9_]*$`).
  Note the asymmetry: **inputs** are snake_case, **outputs** keep the
  upstream Weeek spelling (`projectId`, `hasMore`, `boardId`) so an agent
  can correlate them with the API. Enforced by `mcp.test.ts`.

---

## Logging discipline

- All logs go to **stderr only** via `src/logging/logger.ts`.
- ESLint enforces `no-console: [error, { allow: ['error', 'warn'] }]` in
  `src/**`. The two allowances are for SDK-adjacent fatal-startup paths
  only — prefer the structured logger everywhere else.
- The logger redacts recursively by default (INVARIANT-2). Adding a
  sensitive key? Add it to `REDACT_KEYS` in `src/logging/logger.ts` and to
  the leak-test cases in `tests/logging/`.
- NDJSON: one log line = one JSON object. No multi-line payloads (they
  break log shippers).

---

## Pre-merge checklist

Run all of these before opening or amending a PR. CI runs the same chain
on Node 20 + 22.

```
npm run typecheck         # tsc --noEmit over src/**
npm run typecheck:tests   # tsc -p tsconfig.test.json --noEmit
npm run lint              # eslint src tests --max-warnings 0
npm test                  # vitest single run
npm run coverage          # per-glob V8 thresholds (95/88/100/95 on core)
npm run build             # emit dist/ + chmod +x dist/index.js
```

Doc-side discipline:

- Adding / removing / renaming a tool → update **all** of, in the same PR:
  `README.md`, `README.ru.md`, `examples/*.mcp.json`, `.env.example`,
  `docs/tools.md`, plus the literal tool counts (see the 10 / 15 note at
  the top of this file).
- Changing any tool's `outputSchema` → regenerate the freeze snapshot
  deliberately and review the diff (`npx vitest run -u
  tests/invariants/output-schema-freeze.test.ts`). Every write tool must
  stay byte-identical to `weeek_get_task`'s shape — a write's answer has to
  be readable with what an agent already knows.
- Bumping a pinned dep → write the rationale into the bump commit / PR
  first (see [Tech stack pinning](#tech-stack-pinning)).

---

## What NOT to do

- **Do not break INVARIANT-1.** Even a temporary `console.log` corrupts the
  JSON-RPC stream for every user of the published artifact. Use the
  structured logger; log to stderr.
- **Do not add comment tools.** Weeek Public API v1 has no comment
  endpoints. Do not re-introduce them without proof of new endpoints in
  `docs/weeek-api-notes.md`.
- **Do not write a double type assertion in `src/**`.** `as unknown as T`
  (and its `as any as` / `as never as` variants) silences the checker
  outright; `tests/invariants/type-assertions.test.ts` greps `src/` and
  fails CI naming the file and line. A single `as` narrowing after an
  `instanceof` is fine; the escape hatch is not. If a value will not type,
  change the type the module produces rather than asserting over it. (Tests
  are out of scope — a test forcing a malformed payload past the compiler
  is stating its case, not hiding one.)
- **Do not skip git hooks (`--no-verify`) or signing flags.** If a hook
  fails, fix the underlying issue.
- **Do not use destructive shortcuts.** No `rm -rf` of unfamiliar files; no
  `git reset --hard` to wipe local work; no force-push to shared branches
  without explicit approval.
