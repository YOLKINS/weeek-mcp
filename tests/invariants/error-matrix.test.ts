import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { registerAllTools } from "../../src/tools/registry.js";
import { logger } from "../../src/logging/logger.js";
import type { LoggerMethodSpy } from "../helpers/spies.js";
import { WeeekError, type WeeekErrorCode } from "../../src/weeek/types.js";
import { humanMessage } from "../../src/weeek/humanMessage.js";
import { makeEnvConfig } from "../helpers/factories.js";
import { makeMockMcpServer } from "../helpers/mockMcpServer.js";
import { makeMockWeeekClient } from "../helpers/mockWeeekClient.js";

// RETRO-02 + RETRO-12: per-tool catch-block coverage was asymmetric
// across the `WeeekErrorCode` × weeek-tool grid. This file
// drives every cell once, asserting the four invariants the catch
// blocks promise: `isError: true`, the stable `<tool> failed (<code>): `
// prefix, the `humanMessage(err)` sentence embedded in the text, and
// the warn-payload shape `{ code, status }` with no leaked keys.
//
// Status mapping mirrors the `unwrap.ts` taxonomy. `weeek_network` and
// `weeek_timeout` carry no status (the error is constructed before any
// HTTP response arrives). `weeek_invalid_response` typically carries a
// 2xx status but the parser path also raises it from non-2xx — this
// matrix uses 200 to pin the «2xx-with-bad-body» branch.
//
// I8 (#42): `satisfies Record<WeeekErrorCode, …>` makes the code column
// compile-time exhaustive — a tenth code cannot be added without a row here,
// so the grid can never silently shrink relative to the taxonomy.

const STATUS_FOR_CODE = {
  weeek_unauthorized: 401,
  weeek_forbidden: 403,
  weeek_not_found: 404,
  // Both 400 and 422 produce this code; 422 is the one the live API
  // actually uses for per-field request validation (bug #28).
  weeek_validation_error: 422,
  weeek_rate_limited: 429,
  weeek_server_error: 500,
  weeek_network: undefined,
  weeek_timeout: undefined,
  weeek_invalid_response: 200,
} satisfies Record<WeeekErrorCode, number | undefined>;

const CODES_AND_STATUS: ReadonlyArray<{
  code: WeeekErrorCode;
  status: number | undefined;
}> = Object.entries(STATUS_FOR_CODE).map(([code, status]) => ({
  code: code as WeeekErrorCode,
  status,
}));

const TOOLS: ReadonlyArray<{ name: string; args: Record<string, unknown> }> = [
  { name: "weeek_get_me", args: {} },
  { name: "weeek_list_projects", args: {} },
  { name: "weeek_get_project", args: { project_id: 1 } },
  { name: "weeek_list_tasks", args: {} },
  { name: "weeek_get_task", args: { task_id: 1 } },
  { name: "weeek_list_members", args: {} },
  { name: "weeek_list_tags", args: {} },
  { name: "weeek_list_boards", args: { project_id: 1 } },
  { name: "weeek_list_board_columns", args: { board_id: 1 } },
  // I8 (#43): the write tools join the grid as they land. A mutation's
  // failure path has to be at least as disciplined as a read's — the agent
  // must be able to tell "your token", "your target" and "your arguments"
  // apart without ever seeing a response-body fragment. Registration runs
  // with `READ_ONLY=false` below so the write cells actually exist.
  { name: "weeek_complete_task", args: { task_id: 1 } },
  { name: "weeek_move_task", args: { task_id: 1, board_column_id: 7 } },
  { name: "weeek_create_task", args: { title: "t", project_id: 1 } },
  // With a field named — the empty call never reaches the transport, so it
  // could not exercise a single upstream failure code.
  { name: "weeek_update_task", args: { task_id: 1, title: "t" } },
  // With the field id supplied, so the failing call is the WRITE itself. By
  // name, the custom-fields listing would fail first and every cell would be
  // testing the same read path the other rows already cover.
  {
    name: "weeek_set_task_mr_link",
    args: {
      task_id: 1,
      mr_url: "https://example.com/acme/api/pull/1",
      custom_field_id: "3f6c1b2a-0d4e-4a71-9c33-000000000042",
    },
  },
];

interface MatrixCell {
  tool: string;
  args: Record<string, unknown>;
  code: WeeekErrorCode;
  status: number | undefined;
}

const MATRIX: ReadonlyArray<MatrixCell> = CODES_AND_STATUS.flatMap(
  ({ code, status }) =>
    TOOLS.map((t) => ({ tool: t.name, args: t.args, code, status })),
);

describe("tool error matrix (every WeeekErrorCode × every weeek-tool)", () => {
  beforeEach(() => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "info").mockImplementation(() => {});
    vi.spyOn(logger, "error").mockImplementation(() => {});
  });

  it("the grid covers every registered weeek-tool (no silent gap)", () => {
    // `TOOLS` above is hand-written — it has to be, since each cell needs
    // valid arguments — and a hand-written list is one a new tool can be left
    // out of. Nothing else in this file would notice: a missing row simply
    // means fewer cells. Added in I8 (#45), where `weeek_create_task` landed
    // green with no cells in this grid at all.
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    registerAllTools(srv.server, {
      config: makeEnvConfig({ readOnly: false }),
      weeek: wk.client,
    });
    const registered = srv
      .registrations()
      .map((r) => r.name)
      .filter((n) => n.startsWith("weeek_"));
    const covered = new Set(TOOLS.map((t) => t.name));
    expect(registered.filter((n) => !covered.has(n))).toEqual([]);
  });

  it.each(MATRIX)(
    "$tool fails ($code): isError, prefix, humanMessage, logger.warn(code,status)",
    async ({ tool, args, code, status }) => {
      // `status` is omitted (not set to undefined) for network / timeout
      // — `exactOptionalPropertyTypes: true` rejects `{ status: undefined }`.
      const err = new WeeekError({
        code,
        message: `synthetic ${code}`,
        ...(status !== undefined ? { status } : {}),
      });
      const wk = makeMockWeeekClient();
      wk.rejectAll(err);
      const srv = makeMockMcpServer();
      registerAllTools(srv.server, {
        config: makeEnvConfig({ readOnly: false }),
        weeek: wk.client,
      });

      const out = (await srv.callHandler(tool, args)) as {
        content?: Array<{ text?: string }>;
        isError?: boolean;
      };

      expect(out.isError).toBe(true);
      const text = out.content?.[0]?.text ?? "";
      expect(text).toMatch(/^[a-z_]+ failed \(weeek_[a-z_]+\): /);
      expect(text.startsWith(`${tool} failed (${code}): `)).toBe(true);
      expect(text).toContain(humanMessage(err));

      const warnSpy = logger.warn as unknown as LoggerMethodSpy;
      const matching = warnSpy.mock.calls.filter(
        (c) => c[0] === `${tool} failed`,
      );
      expect(matching.length).toBe(1);
      const ctx = matching[0]?.[1] as Record<string, unknown>;
      expect(ctx.code).toBe(code);
      expect(ctx.status).toBe(status);
      // Only `code` and `status` reach the warn payload — no other
      // keys (defends INV-9 at the per-cell level).
      expect(Object.keys(ctx).sort()).toEqual(["code", "status"]);
    },
  );
});

// I8 (#42), gate G — the published code table cannot drift from the taxonomy.
// `docs/errors.md` is what an agent operator reads to decide what to retry, so
// a code that exists in `WeeekErrorCode` but not in the doc is a silent gap.
// `STATUS_FOR_CODE` above is compile-time exhaustive, so this loop is too.
describe("docs/errors.md documents every WeeekErrorCode", () => {
  const REPO_ROOT = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const doc = readFileSync(path.join(REPO_ROOT, "docs/errors.md"), "utf8");

  it.each(Object.keys(STATUS_FOR_CODE))(
    "%s has a table row with retry guidance",
    (code) => {
      const row = doc
        .split("\n")
        .find((l) => l.startsWith(`| \`${code}\``));
      expect(row, `docs/errors.md needs a | \`${code}\` | … | row`).toBeDefined();
      // code | produced-by | retry? | what-to-do
      expect((row ?? "").split("|").length).toBeGreaterThanOrEqual(5);
    },
  );
});
