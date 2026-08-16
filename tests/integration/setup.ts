// Live-integration test scaffolding. The suite under `tests/integration/`
// hits the real Weeek API at `https://api.weeek.net/public/v1` using the
// token in `WEEEK_INTEGRATION_TOKEN` (deliberately distinct from the
// `WEEEK_ACCESS_TOKEN` env var the MCP server itself reads, so a developer
// running a local server cannot accidentally fire the live suite against
// their personal workspace).
//
// `vitest.config.ts:exclude` keeps `tests/integration/**` out of the
// default `npm test` run; run them with `npm run test:integration`. The
// CI workflow `.github/workflows/live-smoke.yml` fires on `push: tags: ['v*']`
// only — fork PRs never see the secret. When `WEEEK_INTEGRATION_TOKEN` is
// undefined (the common case for local dev), each suite calls
// `describe.skip(...)` so the run stays green.
//
// I8 (#49) adds a second gate on top of the token: the write-cycle suite
// mutates a workspace, so it additionally requires a sandbox project id
// (`WEEEK_INTEGRATION_PROJECT_ID`). A token alone runs the read probes and
// skips the writes — a maintainer who has not nominated a sandbox project
// never has one chosen for them.

import type { WeeekClient } from "../../src/weeek/client.js";
import { createWeeekClient } from "../../src/weeek/client.js";

export interface LiveContext {
  client: WeeekClient;
  token: string;
  // Kept alongside the client because the raw escape below (`deleteRaw`)
  // builds its own request rather than going through it.
  baseUrl: string;
  timeoutMs: number;
}

// The write-cycle suite's context: a token plus the project its fixtures are
// filed into. `projectId` is required rather than discovered from
// `listProjects()[0]` on purpose — "the first project the token can see" is
// not a sandbox, it is whatever the workspace happens to list first.
export interface LiveWriteContext extends LiveContext {
  projectId: number;
}

function buildContext(readOnly: boolean): LiveContext | undefined {
  const token = process.env["WEEEK_INTEGRATION_TOKEN"];
  if (token === undefined || token.length === 0) return undefined;
  // Safe defaults; tests can override base URL via WEEEK_BASE_URL if
  // the maintainer points the workflow at a staging environment.
  const baseUrl =
    process.env["WEEEK_BASE_URL"] ?? "https://api.weeek.net/public/v1";
  const timeoutMs = Number(process.env["WEEEK_TIMEOUT_MS"] ?? 30_000);
  const client = createWeeekClient({
    accessToken: token,
    baseUrl,
    timeoutMs,
    // Inert here — `readOnly` is the *registry's* gate flag and the client
    // never reads it. It is still passed accurately rather than hardcoded
    // `true`, so the config object does not describe the write suite as a
    // read-only one.
    readOnly,
    enabledTools: undefined,
    maxResponseChars: 65_536,
  });
  return { client, token, baseUrl, timeoutMs };
}

/**
 * Returns a live `WeeekClient` if `WEEEK_INTEGRATION_TOKEN` is set,
 * otherwise returns `undefined`. Suites should `describe.skipIf(!ctx)`
 * (or check the result and early-return) to stay green in environments
 * without a token.
 */
export function tryLiveContext(): LiveContext | undefined {
  return buildContext(true);
}

/**
 * The write-suite variant: requires `WEEEK_INTEGRATION_TOKEN` **and**
 * `WEEEK_INTEGRATION_PROJECT_ID`. Returns `undefined` when either is
 * absent, so a contributor with neither — or with a read-only token setup —
 * gets a clean skip rather than a mutation attempt.
 *
 * A *present but malformed* project id throws instead of skipping: it is a
 * misconfiguration, and silently degrading it to "skip" is how a suite ends
 * up never running while looking green.
 */
export function tryLiveWriteContext(): LiveWriteContext | undefined {
  const base = buildContext(false);
  if (base === undefined) return undefined;
  const raw = process.env["WEEEK_INTEGRATION_PROJECT_ID"];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const projectId = Number(raw);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    throw new Error(
      "WEEEK_INTEGRATION_PROJECT_ID must be a positive integer project id",
    );
  }
  return { ...base, projectId };
}

/**
 * Issue a `DELETE` — the write-cycle suite's cleanup, and the only request in
 * this repository that is NOT issued through `WeeekClient`.
 *
 * `WeeekMethod` deliberately cannot express `DELETE` (ADR 0004): removal is
 * not a capability this server hands an agent, and it is irreversible through
 * the Public API even where the row survives behind `isDeleted`
 * (`docs/weeek-api-notes.md`). Widening the production transport so a test can
 * tidy up would trade that guarantee for test convenience — so the harness
 * builds its own request here, in test code, where the capability cannot leak
 * into a tool.
 *
 * Returns the HTTP status; the caller decides what a non-2xx means. No body
 * is returned or logged (INVARIANT-2 discipline applies to test output too).
 */
export async function deleteRaw(
  live: LiveContext,
  path: string,
): Promise<number> {
  const res = await fetch(`${live.baseUrl}${path}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${live.token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(live.timeoutMs),
  });
  return res.status;
}

/**
 * Read a task as the API actually serves it, bypassing `getTask`'s narrowing
 * parser.
 *
 * The tool-facing `TaskDetail` is a deliberate subset (`src/weeek/types.ts`):
 * it carries no `customFields`, no `boardColumnId`, no `dueDate`. Those are
 * exactly the fields the write cycle needs to *verify*, and a write verified
 * only through the shape our own parser produces is a write verified against
 * ourselves. This escape hatch is what makes "the value actually landed
 * upstream" an assertable claim.
 */
export async function readRawTask(
  live: LiveContext,
  taskId: number,
): Promise<Record<string, unknown>> {
  const raw = await live.client.request({
    method: "GET",
    path: `/tm/tasks/${String(taskId)}`,
  });
  const envelope: unknown = raw.body;
  const task =
    typeof envelope === "object" && envelope !== null
      ? (envelope as Record<string, unknown>)["task"]
      : undefined;
  if (typeof task !== "object" || task === null) {
    throw new Error(
      `raw task read for id ${String(taskId)} returned no task object (HTTP ${String(raw.status)})`,
    );
  }
  return task as Record<string, unknown>;
}
