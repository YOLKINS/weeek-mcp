# Contributing to `weeek-mcp`

Thank you for looking. One thing about this repository is unusual — please read
the next section before you write any code.

---

## The posture, plainly

**Issues and feature requests are welcome. Pull requests are by prior
agreement.**

This is not a "drive-by PRs welcome" repository, and saying so is kinder than
letting you find out at review time. If you have found a bug, hit a Weeek API
quirk, want a tool that does not exist, or think a document is wrong — open an
issue. Those are genuinely wanted and are how nearly everything here has been
prioritised.

If you want to *write* the fix, open an issue first and say so. Agreement is
usually a single comment, and it is what turns your patch into something that
can actually be merged.

The reason is the process, not the person. `weeek-mcp` is built as a strictly
linear sequence of increments: one work front at a time, curated commits (no
`wip` / `fix typo` survivors), and `--ff-only` merges so history on `main`
stays linear. A PR that arrives as a few commits against a `main` that has
since moved cannot be fast-forwarded as-is — landing it means re-authoring it
into the current increment, which is work someone has to schedule. Agreeing on
the issue first is how that gets scheduled instead of stalled.

**Push and publish are maintainer-owned.** Contributors — human or agent — do
local git only; nobody else pushes to `origin`, and the release itself is a
maintainer-dispatched run of
[`.github/workflows/release.yml`](.github/workflows/release.yml) against the
version tag. It runs the same gates as below plus coverage, refuses a version
that does not match the tag or that npm already has, and publishes with
provenance.

---

## Reproducing the CI gate locally

These are the gates [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs,
in the same order, on Node 20 and Node 22. Run all of it before you ask for a
review; a red CI on a PR that has never been run locally is the most expensive
kind of round trip.

```bash
npm ci

npm run typecheck         # tsc --noEmit over src/**
npm run typecheck:tests   # tsc -p tsconfig.test.json --noEmit
npm run lint              # eslint src tests --max-warnings 0
npm test                  # vitest single run — never touches the network
npm run coverage          # per-glob V8 thresholds (95/88/100/95 on core)
npm run build             # emit dist/ + chmod +x dist/index.js
```

Two of those are worth a note:

- **`npm test` is offline by design.** The live suites under
  `tests/integration/` are excluded from it and run only via
  `npm run test:integration`, gated on `WEEEK_INTEGRATION_TOKEN` /
  `WEEEK_INTEGRATION_PROJECT_ID`. With the variables unset every live suite
  skips cleanly, so a contributor without a Weeek sandbox still gets a green
  local run.
- **`npm run coverage` is not optional.** The per-glob thresholds are a ratchet
  over the whole `src/**` surface, and `npm test` does not enforce them.

Requirements: Node `>=20` to run the server; the dev toolchain floor is higher
(ESLint 10 declares `^20.19.0 || ^22.13.0 || >=24`), which is why the CI matrix
asks for `20.x` / `22.x` rather than pinned patches.

---

## Local development

```bash
git clone https://github.com/YOLKINS/weeek-mcp.git
cd weeek-mcp
npm install
npm run build
npm run inspect   # opens MCP Inspector against dist/index.js
```

| Command | Purpose |
|---|---|
| `npm run dev` | Run directly from TS via tsx (no build) |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run compiled `dist/index.js` |
| `npm run typecheck` | `tsc --noEmit` over `src/**` |
| `npm run typecheck:tests` | Type-check `src/**` + `tests/**` (no emit) |
| `npm run lint` | `eslint src tests --max-warnings 0` |
| `npm test` | Run unit tests once (vitest) |
| `npm run test:integration` | Token-gated live suites against the real Weeek API |
| `npm run coverage` | Run tests with V8 coverage report |
| `npm run inspect` | Launch MCP Inspector against the compiled binary |

The **live-integration** suites (`npm run test:integration`) are gated on
`WEEEK_INTEGRATION_TOKEN` — a **sandbox** token, deliberately a different
variable from `WEEEK_ACCESS_TOKEN` so a running local server cannot fire the
live suite at your personal workspace — and, for the write cycle,
`WEEEK_INTEGRATION_PROJECT_ID`. With them unset the suites skip cleanly. The
write cycle creates a task, edits / moves / links / completes it, then deletes
it — every leg verified by re-reading, because Weeek answers a wrongly-shaped
write with `200` and silently discards the value. The sandbox project needs a
board with **at least two columns** (a move needs somewhere to go).

---

## Before you change code

[`CLAUDE.md`](CLAUDE.md) is the agent-facing contract for this repo, and its
**MCP invariants** section is worth reading even if you are not an agent. Two
that catch newcomers:

- **INVARIANT-1 — stdout belongs to the SDK.** `process.stdout` *is* the
  JSON-RPC channel. A single `console.log` anywhere in `src/**` corrupts every
  connected client's parser. Log to stderr through `src/logging/logger.ts`;
  ESLint fails the build on `console.log`.
- **INVARIANT-2 / -9 — tokens and request bodies are never logged.** The logger
  redacts recursively, and tool errors render through `humanMessage(err)`
  rather than echoing `err.message`. Do not log an error message from a Weeek
  call.

One asymmetry trips everyone once: **tool inputs are snake_case** (`project_id`,
`task_id`, `per_page`) with no camelCase aliases, while **tool outputs keep
Weeek's own spelling** (`projectId`, `boardId`, `hasMore`) so an agent can
correlate them with the API docs verbatim. Do not "fix" a camelCase field in an
`outputSchema`. Adding, removing, or renaming a tool touches the two READMEs,
`examples/*.mcp.json`, `.env.example`, `docs/tools.md`, and the literal tool
counts pinned in the test suite — all in the same PR. `CLAUDE.md` carries the
full checklist and the reasoning behind each pinned dependency.

---

## Reporting a security issue

Do **not** open a public issue. See [SECURITY.md](SECURITY.md) for the private
reporting channel and the threat model this server actually has.

---

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
(Contributor Covenant 2.1). Reports go to <yolochkas@proton.me>.

---

## Where to start reading

| You want to… | Read |
|---|---|
| use the server | [`README.md`](README.md) / [`README.ru.md`](README.ru.md) |
| change the code | [`CLAUDE.md`](CLAUDE.md) — invariants, pins, pre-merge chain |
| understand an error code | [`docs/errors.md`](docs/errors.md) |
| read the full tool reference | [`docs/tools.md`](docs/tools.md) |
| understand a Weeek API quirk | [`docs/weeek-api-notes.md`](docs/weeek-api-notes.md) |

Issues live in
[`YOLKINS/weeek-mcp`](https://github.com/YOLKINS/weeek-mcp/issues).
