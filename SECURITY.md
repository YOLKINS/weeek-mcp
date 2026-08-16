# Security policy

## Reporting a vulnerability

**Please do not open a public issue.** A token-leak path is exactly the class
of report that a public tracker handles worst.

1. **Preferred — GitHub private vulnerability reporting.** Open a private
   advisory at
   <https://github.com/YOLKINS/weeek-mcp/security/advisories/new>
   (repository → **Security** → **Report a vulnerability**). The thread stays
   private, and a fix can be prepared and released before anything is
   published.
2. **Fallback — email.** <yolochkas@proton.me>. Use this if private reporting
   is unavailable to you for any reason. Please include `weeek-mcp security`
   in the subject.

A useful report contains: the version (`npm ls weeek-mcp`, or the commit), the
relevant environment (`READ_ONLY`, `ENABLED_TOOLS`, `LOG_LEVEL` — **never the
token itself**), what you observed, and what you expected instead. A minimal
reproduction is worth more than a long description.

**What to expect.** This is a single-maintainer project, so the honest
commitment is modest rather than impressive: acknowledgement within **7 days**,
and either a fix or a written plan with a date within **30 days**. If the
report is valid you will be credited in the advisory unless you ask not to be.
If you have a disclosure deadline, say so in the first message.

---

## Supported versions

| Version | Security fixes |
|---|---|
| The most recent minor line published to npm `latest` | ✅ — shipped as a patch release on that line |
| Anything older | ❌ — no backports |

There is one dist-tag (`latest`) and no long-term-support line. Upgrading
within a minor line is safe by construction: the tool surface, its
`outputSchema`s and its `tools/list` payload are pinned in CI, so a patch
cannot move the contract your client validates against.

---

## Threat model

`weeek-mcp` is **a local process**, not a service. Your MCP client (Claude
Desktop, Cursor, Cline, …) spawns it, speaks JSON-RPC to it over stdin/stdout,
and kills it. It listens on no port and accepts no network connections. Its
only outbound traffic is HTTPS to the Weeek API (`WEEEK_BASE_URL`, default
`https://api.weeek.net/public/v1`). There is no telemetry, no analytics and no
crash reporting.

What makes it security-relevant anyway is what it holds and what it can do:

- **It holds a Weeek workspace API token**, supplied as `WEEEK_ACCESS_TOKEN`
  in its environment. The server never reads a `.env` file; the token arrives
  from your MCP client's `env` block or your shell.
- **Under `READ_ONLY=false` it can mutate a live tracker** — create, edit,
  move and complete tasks in a real workspace, on behalf of a model.

So the assets are: the token, the workspace data the token can read, and the
workspace's integrity under write. The party the design does not fully trust
is **the model driving the client** — it may be steered by task content it
reads. Hence the defaults below.

### Security-relevant properties, and what enforces each

Each of these is machine-enforced by a numbered invariant in
[`CLAUDE.md`](CLAUDE.md), asserted by tests under `tests/invariants/`. A break
in one is a vulnerability; the behaviour they describe is not.

**1. stdout purity.** `process.stdout` is the JSON-RPC channel and nothing
else writes to it. A stray byte from anywhere in `src/**` corrupts every
client's parser — and, worse, anything printed there is fed straight into the
client's message stream rather than to a log.

- **INVARIANT-1** — no `console.log` / `process.stdout.write` anywhere in
  `src/**`; ESLint's `no-console` fails the build, and a stdout spy is driven
  through every tool's success path and every Weeek-backed tool's error path
  (`tests/invariants/mcp.test.ts`; `ping` makes no Weeek call, so it has no
  error path to sweep).
- **INVARIANT-11** — a spawned `dist/index.js` writes **zero bytes** to
  stdout in its first 500 ms, under the default config, under
  `READ_ONLY=false`, and under a single-write-tool allowlist
  (`tests/invariants/registry-smoke.test.ts`). This covers the startup path
  that the in-process spy cannot see.

**2. Token and request-body redaction.** All logs go to **stderr** as NDJSON
via `src/logging/logger.ts`, and the token never appears in any of them.

- **INVARIANT-2** — the logger redacts recursively before a line is written.
  The key set is `accessToken`, `WEEEK_ACCESS_TOKEN`, `authorization`,
  `password`, `secret`, `apiKey`, `api_key`, `token`, matched
  case-insensitively and **exactly** — exact rather than substring so that
  `accessTokenPresent` (a boolean flag) does not collide with `accessToken`
  (the secret). A match replaces non-empty **string** values with
  `[REDACTED]`; anything else under such a key is recursed into rather than
  masked, so a secret nested one level deeper is caught by its own key, not
  by its parent's. Request bodies are never logged at all.
- **INVARIANT-7** — a tool error renders as
  `<tool> failed (<weeek_code>): <english sentence>` from
  `src/weeek/humanMessage.ts`. `err.message`, `err.cause` and Weeek response
  bodies are never echoed to the client.
- **INVARIANT-9** — the converse, asserted from the consumer side: the
  `logger.warn` context on an error path is `{ code, status }` and nothing
  else — no title, description, email or payload. Tests drive every tool's
  error path with deliberately seeded leak strings and grep the log output
  for them.
- **INVARIANT-8** — an env deprecation warning names the *variable*, never
  its value. Its original subject — the `WEEEK_API_TOKEN` /
  `WEEEK_API_BASE_URL` aliases — was removed for the `1.0.0` line, so it has
  no live subject today; it stays on the books to govern the next alias.

**3. Read-only by default.** `READ_ONLY` defaults to `true`, and the gate runs
at **registration**: a gated tool is never registered, so it does not appear
in `tools/list` and the SDK answers a call to it with `Tool not found` rather
than running it. A default install physically cannot change your workspace.
`ENABLED_TOOLS` narrows further, to an explicit allowlist of names, which is
what makes a one-tool rollout (`READ_ONLY=false
ENABLED_TOOLS=weeek_complete_task`) meaningful.

- **INVARIANT-10** — every tool registered under `READ_ONLY=true` carries
  `annotations.readOnlyHint: true`.
- **INVARIANT-12** — the converse: every registry entry marked
  `readOnly: false` carries `annotations.readOnlyHint: false`. Together the
  two force the gate's flag and the client-facing annotation to be exact
  negations, so the hint an MCP client shows a user cannot drift from the
  gate that actually decides. The assertion derives the write set *from the
  gate* rather than from a hand-written list, so a write tool cannot be added
  without moving both.

### In scope

Reports along these lines are wanted:

- The token, or any fragment of it, reaching stdout, stderr, a tool result,
  or an error message.
- A Weeek response body, request body, or `err.message` reaching a client
  through a tool error or a log line.
- A tool with `readOnly: false` being registered while `READ_ONLY=true`, or
  any other way to reach a write path without the operator opting in.
- Any byte written to stdout that is not an SDK-produced JSON-RPC message.
- A crafted Weeek API response causing anything worse than a
  `weeek_invalid_response` error — path traversal, code execution, unbounded
  memory growth, a hang past `WEEEK_TIMEOUT_MS`.
- A dependency vulnerability that is actually reachable from this code.

### Out of scope

- **The scope of the token's own workspace permissions.** A Weeek personal
  API token carries whatever access the account behind it has, and this
  server cannot narrow it — Weeek grants that scope and the operator chooses
  which account and workspace to point at. "`weeek_update_task` edited a task
  my token was allowed to edit" is the design, not a vulnerability. If you
  want a smaller blast radius, use a token from an account with narrower
  workspace access; that control lives in Weeek, not here.
- **Consequences of `READ_ONLY=false`.** Turning the gate off is an explicit,
  documented decision that hands a model the ability to mutate your tracker.
  A model then doing so — including at the suggestion of text it read from a
  task — is the risk being accepted, not a flaw in the gate. The gate's job is
  to be off only when you said so; that part *is* in scope.
- **Vulnerabilities in the Weeek API or the Weeek product.** Report those to
  Weeek directly. If the flaw is in how *this* server calls the API, it is in
  scope here.
- **Anything requiring an attacker who already has your machine, your shell,
  or your environment variables.** At that point the token is theirs
  regardless of this server.
- A `README` or configuration example that shows a placeholder token. If you
  find a **real** credential committed anywhere, that is in scope and urgent —
  report it privately.
