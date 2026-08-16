# weeek-mcp

Local, read-only-by-default MCP server for [Weeek](https://weeek.net/) — with opt-in write tools.

[![npm version](https://img.shields.io/npm/v/weeek-mcp.svg)](https://www.npmjs.com/package/weeek-mcp)
[![npm downloads](https://img.shields.io/npm/dm/weeek-mcp.svg)](https://www.npmjs.com/package/weeek-mcp)
[![CI](https://github.com/YOLKINS/weeek-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/YOLKINS/weeek-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-2025--06--18-blue.svg)](https://modelcontextprotocol.io/)

[Русская версия README](README.ru.md)

`weeek-mcp` connects AI clients (Claude Desktop, Claude Code, Cursor, MCP
Inspector) to your Weeek workspace over stdio. It is **read-only by default** —
a default install can list projects, tasks, boards, members and tags but change
nothing — and exposes five write tools only when you opt in with `READ_ONLY=false`.
Runs on Node ≥ 20; install with `npx`, no clone or build required.

## Why this one

- **On npm.** `npx -y weeek-mcp` works today — no clone, no build, no absolute paths.
- **Read-only by default, with composable gates.** Writes are simply not
  registered unless you opt in; `ENABLED_TOOLS` whitelists a subset and
  `MAX_RESPONSE_CHARS` caps every payload. Server-side, not client convention.
- **Bilingual.** Full EN ↔ RU documentation parity.
- **Granular error model.** Nine distinct error codes with agent-readable
  messages, so a model knows when to retry versus give up without parsing prose.

## Quickstart

The recommended install path is `npx` — no clone, no build. Drop
[examples/claude_desktop.mcp.json](examples/claude_desktop.mcp.json) into your
MCP client config, replace `YOUR_WEEEK_TOKEN_HERE` with a real token from
<https://app.weeek.net/ws/_/settings/apps/api>, and restart the client:

```json
{
  "mcpServers": {
    "weeek": {
      "command": "npx",
      "args": ["-y", "weeek-mcp"],
      "env": {
        "WEEEK_ACCESS_TOKEN": "YOUR_WEEEK_TOKEN_HERE"
      }
    }
  }
}
```

`npx` downloads `weeek-mcp` on first launch and caches it. Cursor and Cline use
the same `mcpServers` shape — see [examples/cursor.mcp.json](examples/cursor.mcp.json)
and [examples/cline.mcp.json](examples/cline.mcp.json). Other env vars have safe
defaults; override only what you need (see [Configuration](#configuration)). If
`npx` cannot find `node` (typical with `nvm`), see
[Troubleshooting](#troubleshooting); for a zero-dependency smoke test see
[docs/smoke.md](docs/smoke.md).

> `examples/` lives on GitHub only — the npm tarball ships `dist/` +
> `README.md` + `README.ru.md` + `LICENSE`.

## Tools

Ten **read** tools are exposed by default. All fifteen appear only under
`READ_ONLY=false` (see [Enabling write tools](#enabling-write-tools)).

| Read tool | Returns |
|---|---|
| `ping` | `pong: <msg>` — transport health check, no API call, no token |
| `weeek_get_me` | the authenticated user (`id`, `email`, `name`) — confirms the token |
| `weeek_list_projects` | every project visible to the token |
| `weeek_get_project` | a single project by id, including its `description` |
| `weeek_list_tasks` | one page of tasks (filters + offset/`per_page` pagination) |
| `weeek_get_task` | a single task by id, with multi-assignee fields |
| `weeek_list_members` | every workspace member |
| `weeek_list_tags` | every tag |
| `weeek_list_boards` | every board in a project |
| `weeek_list_board_columns` | every column of a board, in sort order |

| Write tool (`READ_ONLY=false`) | Does |
|---|---|
| `weeek_complete_task` | flips the completion flag; `completed: false` re-opens |
| `weeek_move_task` | moves a task to a board column (a column *is* a status) |
| `weeek_create_task` | files a new task and returns it with its new id |
| `weeek_update_task` | edits title / priority / type / due date |
| `weeek_set_task_mr_link` | records a merge/pull-request URL in a custom field |

Full field-level reference (inputs, outputs, edge cases, truncation,
multi-assignee) → [docs/tools.md](docs/tools.md).

## Enabling write tools

**The default install cannot change anything in your workspace.** All five
mutating tools are hidden behind `READ_ONLY` (default `true`) — not registered,
so they never appear in `tools/list`. Setting `READ_ONLY=false` takes
`tools/list` from ten tools to fifteen and lets the agent **create, edit, move
and complete tasks in the workspace the token can reach**. There is no
server-side confirmation step — `annotations` are a hint an MCP client is free
to ignore. Point the token at a workspace whose contents you are willing to see
changed.

```json
"env": {
  "WEEEK_ACCESS_TOKEN": "YOUR_WEEEK_TOKEN_HERE",
  "READ_ONLY": "false"
}
```

**Start with one tool, not five.** `READ_ONLY=false` intersected with
`ENABLED_TOOLS` gives you writes on, but only the one you asked for:

```json
"env": {
  "WEEEK_ACCESS_TOKEN": "YOUR_WEEEK_TOKEN_HERE",
  "READ_ONLY": "false",
  "ENABLED_TOOLS": "weeek_complete_task"
}
```

`READ_ONLY` is the **outer** gate: naming a write tool in `ENABLED_TOOLS` does
not by itself opt into writes. The allowlist is not additive, so list the read
tools you need alongside it —
[examples/claude_desktop.write.mcp.json](examples/claude_desktop.write.mcp.json)
is a ready-to-edit config that does exactly that.

### What each write tool can and cannot do

| Tool | Changes | Undone by | `destructiveHint` | `idempotentHint` |
|---|---|---|---|---|
| `weeek_complete_task` | one completion flag | re-firing with `completed: false` | `false` | `true` |
| `weeek_set_task_mr_link` | one custom field's value | re-setting it | `false` | `true` |
| `weeek_move_task` | the task's board column (and board) | moving it back — if you know where it was | `true` | `false` |
| `weeek_update_task` | title / priority / type / due date | re-setting each field — if you know the old value | `true` | `false` |
| `weeek_create_task` | files a **new** task | deleting it, which this server cannot do | `true` | `false` |

The three `true` rows are marked "worth a human confirm" because **the agent
never saw the old value** and cannot put it back; `weeek_create_task` is the one
to watch — its effect cannot be undone through this server, and a retried create
files a **second** task. `weeek_set_task_mr_link` resolves its custom field by
name unless you pass `custom_field_id` / `custom_field_name` — the matched names
and ambiguity rules are in
[docs/tools.md](docs/tools.md#the-mr-link-field-naming-convention).

## Configuration

Read from the environment at startup and validated with zod; invalid values
abort startup on stderr with a non-zero exit code. The server never reads a
`.env` file itself — pass variables through your MCP client's `env` block or
your shell.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `WEEEK_ACCESS_TOKEN` | yes | — | Personal Weeek API token (≥ 20 chars; placeholders and whitespace-padded values are rejected). |
| `WEEEK_BASE_URL` | no | `https://api.weeek.net/public/v1` | Base URL for the Weeek HTTP client. Override for self-hosted proxies. |
| `WEEEK_TIMEOUT_MS` | no | `30000` | Per-request timeout (ms). Positive integer. |
| `READ_ONLY` | no | `true` | Hide write tools. When `true`, any tool whose `readOnlyHint !== true` is not registered. Accepts `true`/`false`/`1`/`0`. |
| `ENABLED_TOOLS` | no | (unset = all) | Comma-separated allowlist of tool names, still intersected with `READ_ONLY`. Unknown names WARN; an empty result aborts startup. |
| `MAX_RESPONSE_CHARS` | no | `65536` | Byte budget per response; over-budget payloads are clipped and flagged `truncated: true`. Min `1024`, max `1000000`. |
| `LOG_LEVEL` | no | `info` | Logger threshold: `debug`, `info`, `warn`, `error`. Unknown values fall back to `info`. |

Both gates run **server-side**: a hidden tool is not registered, so an agent
cannot call it. `READ_ONLY` is load-bearing — leave it at the default unless you
intend an agent to change your workspace. See [.env.example](.env.example) for a
copy-pasteable template.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Server doesn't appear in the client | `command` points at a `node` the client cannot find, or `dist/index.js` is missing/non-executable | Run `npm run build`; confirm `ls -la dist/index.js` shows `0755`. Use the absolute path from `which node` (see NVM note below). |
| `MCP server failed to start` immediately | Same as above, plus `node_modules` missing | Run `npm install && npm run build` from the repo root. |
| `invalid env: WEEEK_ACCESS_TOKEN: ...` on stderr | Token contains whitespace/control chars, or is the placeholder | Generate a real token at <https://app.weeek.net/ws/_/settings/apps/api> and paste it without surrounding spaces or newlines. |
| `invalid env: WEEEK_BASE_URL: ...` | URL uses a non-`http(s)` scheme or contains `user:pass@` | Use plain `https://api.weeek.net/public/v1`; route credentials through `WEEEK_ACCESS_TOKEN`. |
| `EACCES` launching `dist/index.js` | `postbuild` chmod skipped | `chmod +x dist/index.js`. |
| `npm start` works but the client fails | The client launches under a different `PATH` than your shell | See the NVM workaround below. |

<details>
<summary><b>NVM workaround</b> — <code>spawn npx ENOENT</code> / <code>spawn node ENOENT</code></summary>

Claude Desktop and Cursor launch their MCP subprocess under a non-interactive
shell that does **not** source `~/.nvm/nvm.sh`, so a bare `"command": "npx"`
silently fails when Node is installed via nvm. Either hard-code an absolute path
— run `which npx` and paste the result as `command` (update it whenever you
switch nvm version); the package is still downloaded and cached on first run:

```json
{ "command": "/Users/<you>/.nvm/versions/node/v20.18.0/bin/npx", "args": ["-y", "weeek-mcp"] }
```

— or point `command` at a small wrapper script that sources `~/.nvm/nvm.sh`
before `exec npx "$@"`, which survives nvm version changes.

</details>

## Errors

Every Weeek tool fails the same way: `isError: true` with a single-line
`<tool> failed (<weeek_code>): <one English sentence>`. The `weeek_<code>` token
is the stable, machine-greppable contract; the sentence guides self-correction.
Nine codes cover unauthorized / forbidden / not-found / validation / rate-limit
/ server / network / timeout / invalid-response, each with retry guidance.

```
weeek_get_task failed (weeek_not_found): Weeek returned 404 for this resource. Verify the id exists in the configured workspace and was not deleted.
weeek_list_tasks failed (weeek_rate_limited): Weeek rate-limited the request (HTTP 429). Retry after a brief delay or reduce the call frequency.
```

Full table with retry semantics → [docs/errors.md](docs/errors.md).

## Contributing · Security · License

- **Contributing** — issues and feature requests are welcome; **pull requests
  are by prior agreement** (this repo runs a strictly linear increment process).
  See [CONTRIBUTING.md](CONTRIBUTING.md).
- **Security** — found a way to leak the token or a byte on stdout? Do not open
  a public issue; see [SECURITY.md](SECURITY.md) for the private channel and
  threat model.
- **License** — [MIT](LICENSE).
- **For AI coding agents** — the entry-point contract (invariants, pinned deps,
  pre-merge checklist) lives in [CLAUDE.md](CLAUDE.md).

`CONTRIBUTING.md`, `SECURITY.md` and `CLAUDE.md` live on GitHub only — like
`examples/`, they are not in the npm tarball. `LICENSE` is the exception: it
ships inside the package.
