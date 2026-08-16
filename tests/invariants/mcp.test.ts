import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { registerAllTools } from "../../src/tools/registry.js";
import { logger } from "../../src/logging/logger.js";
import type { LoggerMethodSpy } from "../helpers/spies.js";
import { WeeekError } from "../../src/weeek/types.js";
import { humanMessage } from "../../src/weeek/humanMessage.js";
import {
  makeEnvConfig,
  makeEnvelope,
  makeUserPayload,
  makeProjectPayload,
  makeTaskSummaryPayload,
  makeTaskDetailPayload,
  makeMemberPayload,
  makeProjectDetailPayload,
  makeTagPayload,
  makeBoardPayload,
  makeBoardColumnPayload,
  makeCustomFieldPayload,
} from "../helpers/factories.js";
import { makeMockMcpServer } from "../helpers/mockMcpServer.js";
import { makeMockWeeekClient } from "../helpers/mockWeeekClient.js";
import { WEEEK_PATH } from "../helpers/paths.js";
import { READ_TOOLS, WRITE_TOOLS, ALL_TOOLS } from "../helpers/toolNames.js";

// I8: every cross-cutting sweep below registers under `READ_ONLY=false`, so
// write tools are held to the same contract as reads from their first day.
const TOOLS_WITH_TRUNCATION = [
  "weeek_list_projects",
  "weeek_get_project",
  "weeek_list_tasks",
  "weeek_list_members",
  "weeek_list_tags",
  "weeek_get_task",
  "weeek_list_boards",
  "weeek_list_board_columns",
  // A write returns the same task-detail shape a read does, so it carries the
  // same `truncated` signal (INVARIANT-5).
  "weeek_complete_task",
  "weeek_move_task",
  "weeek_create_task",
  "weeek_update_task",
  "weeek_set_task_mr_link",
] as const;

interface SuccessPayloads {
  [path: string]: unknown;
}

const HAPPY_BODIES: SuccessPayloads = {
  [WEEEK_PATH.userMe]: makeEnvelope("user", makeUserPayload()),
  [WEEEK_PATH.projectsList]: makeEnvelope("projects", [makeProjectPayload()]),
  [WEEEK_PATH.projectById(1)]: makeEnvelope(
    "project",
    makeProjectDetailPayload({ id: 1 }),
  ),
  // weeek_list_tasks input has perPage.default(20) (D3 in I7-prep), so the
  // default-args call lands on /tm/tasks?perPage=20, not the bare path.
  [`${WEEEK_PATH.tasksList}?perPage=20`]: {
    ...makeEnvelope("tasks", [makeTaskSummaryPayload()]),
    hasMore: false,
  },
  [WEEEK_PATH.taskById(1)]: makeEnvelope(
    "task",
    makeTaskDetailPayload({ id: 1 }),
  ),
  [WEEEK_PATH.membersList]: makeEnvelope("members", [makeMemberPayload()]),
  [WEEEK_PATH.tagsList]: makeEnvelope("tags", [makeTagPayload()]),
  [`${WEEEK_PATH.boardsList}?projectId=1`]: makeEnvelope("boards", [
    makeBoardPayload({ projectId: 1 }),
  ]),
  [`${WEEEK_PATH.boardColumnsList}?boardId=1`]: makeEnvelope(
    "boardColumns",
    [makeBoardColumnPayload({ boardId: 1 })],
  ),
  // Read INTERNALLY by `weeek_set_task_mr_link`'s by-name resolution (#47) —
  // there is no listing tool over it, so it appears here as a fixture only.
  [WEEEK_PATH.customFieldsList]: makeEnvelope("data", [
    makeCustomFieldPayload(),
  ]),
};

// Write legs: the bare `{success:true}` ack the mutating routes answer with.
// The task each write returns comes from the read-back GET already seeded
// above, so a write tool needs no extra body fixture.
const HAPPY_WRITE_ACKS: readonly string[] = [
  WEEEK_PATH.taskComplete(1),
  WEEEK_PATH.taskUnComplete(1),
];

interface CallSpec {
  name: string;
  args: Record<string, unknown>;
}
const HAPPY_CALLS: CallSpec[] = [
  { name: "ping", args: { msg: "x" } },
  { name: "weeek_get_me", args: {} },
  { name: "weeek_list_projects", args: {} },
  { name: "weeek_get_project", args: { project_id: 1 } },
  { name: "weeek_list_tasks", args: {} },
  { name: "weeek_get_task", args: { task_id: 1 } },
  { name: "weeek_list_members", args: {} },
  { name: "weeek_list_tags", args: {} },
  { name: "weeek_list_boards", args: { project_id: 1 } },
  { name: "weeek_list_board_columns", args: { board_id: 1 } },
  { name: "weeek_complete_task", args: { task_id: 1, completed: true } },
  { name: "weeek_move_task", args: { task_id: 1, board_column_id: 7 } },
  { name: "weeek_create_task", args: { title: "t", project_id: 1 } },
  // Names a field: an argument-less update is refused locally and never
  // reaches the client, which would make it invisible to every sweep here.
  { name: "weeek_update_task", args: { task_id: 1, title: "t" } },
  // By NAME, not by id: the by-name form is the one that issues the
  // custom-fields listing, so the sweeps drive both legs of the tool. The
  // listing fixture is seeded in `setupHappyClient` below.
  {
    name: "weeek_set_task_mr_link",
    args: { task_id: 1, mr_url: "https://example.com/acme/api/pull/1" },
  },
];

// One name → args table, derived from HAPPY_CALLS. Before I8 this lived twice:
// here and as a ternary chain 500 lines down in the truncation test, which is
// exactly the kind of second copy that drifts when a tool is added.
const ARGS_FOR: Record<string, Record<string, unknown>> = Object.fromEntries(
  HAPPY_CALLS.map((c) => [c.name, c.args]),
);

function setupHappyClient() {
  const wk = makeMockWeeekClient();
  for (const [path, body] of Object.entries(HAPPY_BODIES)) {
    wk.whenRequest("GET", path, { status: 200, body });
  }
  for (const path of HAPPY_WRITE_ACKS) {
    wk.whenRequest("POST", path, { status: 200, body: { success: true } });
  }
  // `PUT /tm/tasks/{id}` answers with the full updated task (the write echo),
  // unlike the ack-only completion routes above. `POST /tm/tasks` — the create
  // — echoes the same way, on the same path the list read uses.
  wk.whenRequest("PUT", WEEEK_PATH.taskById(1), {
    status: 200,
    body: makeEnvelope("task", makeTaskDetailPayload({ id: 1 })),
  });
  wk.whenRequest("POST", WEEEK_PATH.tasksList, {
    status: 200,
    body: makeEnvelope("task", makeTaskDetailPayload({ id: 1 })),
  });
  return wk;
}

// Every cross-cutting sweep runs with writes exposed: a write tool must clear
// the same annotation / description / snake_case / no-leak bars as a read.
function makeSweepConfig(
  overrides: Parameters<typeof makeEnvConfig>[0] = {},
): ReturnType<typeof makeEnvConfig> {
  return makeEnvConfig({ readOnly: false, ...overrides });
}

describe("MCP cross-cutting invariants", () => {
  beforeEach(() => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "info").mockImplementation(() => {});
    vi.spyOn(logger, "error").mockImplementation(() => {});
  });

  it("HAPPY_CALLS drives every registered tool (no silently-unswept tool)", () => {
    // Half the sweeps below iterate `HAPPY_CALLS`, a hand-written table — it
    // has to be, since each call needs valid arguments. A tool left out of it
    // is simply never swept, and every assertion in this file still passes.
    // Added in I8 (#45): `weeek_create_task` first landed green while sitting
    // outside all five happy-path sweeps.
    const srv = makeMockMcpServer();
    registerAllTools(srv.server, {
      config: makeSweepConfig(),
      weeek: setupHappyClient().client,
    });
    const registered = srv.registrations().map((r) => r.name);
    const covered = new Set(HAPPY_CALLS.map((c) => c.name));
    expect(registered.filter((n) => !covered.has(n))).toEqual([]);
  });

  it("every registered tool has all 4 annotation hints set to a boolean", () => {
    const srv = makeMockMcpServer();
    const wk = setupHappyClient();
    registerAllTools(srv.server, {
      config: makeSweepConfig(),
      weeek: wk.client,
    });
    for (const reg of srv.registrations()) {
      const ann = reg.config.annotations ?? {};
      for (const hint of [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ]) {
        expect(typeof ann[hint]).toBe("boolean");
      }
    }
  });

  it("READ_ONLY-gated registrations all carry readOnlyHint=true (INVARIANT-10, RETRO-03)", () => {
    // Tripwire over the duplicate-source-of-truth between
    // `registry.ts:entries[i].readOnly` and each tool's
    // `annotations.readOnlyHint`. This half guards the READ set: anything
    // the gate lets through under the default `READ_ONLY=true` must
    // advertise itself as a read. A write tool whose registry flag was
    // never flipped to `false` would leak past the gate and fail here.
    // INVARIANT-12 below guards the converse.
    const srv = makeMockMcpServer();
    const wk = setupHappyClient();
    registerAllTools(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    for (const reg of srv.registrations()) {
      const hint = reg.config.annotations?.["readOnlyHint"];
      expect(hint, `tool ${reg.name} registered under READ_ONLY=true`).toBe(true);
    }
  });

  it("every write-gated registration carries readOnlyHint=false (INVARIANT-12, ADR 0004 §3)", () => {
    // The converse of INVARIANT-10, and the reason it is safe to keep the
    // gate flag and the client-facing annotation as two copies at all.
    // The write set is DERIVED from the gate itself — the tools the
    // `READ_ONLY=false` registration adds over the `READ_ONLY=true` one —
    // rather than from a hand-written list, so it is exactly the set of
    // `readOnly: false` registry entries with no third copy to drift.
    const readSrv = makeMockMcpServer();
    registerAllTools(readSrv.server, {
      config: makeEnvConfig(),
      weeek: setupHappyClient().client,
    });
    const writeSrv = makeMockMcpServer();
    registerAllTools(writeSrv.server, {
      config: makeEnvConfig({ readOnly: false }),
      weeek: setupHappyClient().client,
    });
    const readNames = new Set(readSrv.registrations().map((r) => r.name));
    const writeRegs = writeSrv
      .registrations()
      .filter((r) => !readNames.has(r.name));

    // Guard the guard: an empty diff would make every assertion below vacuous.
    expect(writeRegs.map((r) => r.name)).toEqual([...WRITE_TOOLS]);
    for (const reg of writeRegs) {
      expect(
        reg.config.annotations?.["readOnlyHint"],
        `write tool ${reg.name} must advertise readOnlyHint:false`,
      ).toBe(false);
    }
  });

  it("no input property name on any tool contains an uppercase letter (INVARIANT-13, D4)", () => {
    // D4 (#41) flipped the whole input surface to snake_case in one jump,
    // with no camelCase aliases. This sweep is the tripwire that keeps it
    // that way: a future tool born with `boardColumnId` fails here rather
    // than silently re-opening the mixed-convention window D4 closed.
    // Deliberately a sweep over `registrations()`, not a fixed list — a
    // tool added without touching this file is still covered.
    const srv = makeMockMcpServer();
    const wk = setupHappyClient();
    registerAllTools(srv.server, {
      config: makeSweepConfig(),
      weeek: wk.client,
    });
    for (const reg of srv.registrations()) {
      const shape = (reg.config.inputSchema ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(shape)) {
        expect(
          /^[a-z][a-z0-9_]*$/.test(key),
          `tool ${reg.name} input '${key}' is not snake_case`,
        ).toBe(true);
      }
    }
  });

  it("the six D4-renamed inputs are present under their snake_case names", () => {
    // Pins the rename itself (the sweep above only forbids uppercase — an
    // input dropped entirely, or renamed to something else lowercase, would
    // pass it). One row per rename in the D4 table.
    const srv = makeMockMcpServer();
    const wk = setupHappyClient();
    registerAllTools(srv.server, {
      config: makeSweepConfig(),
      weeek: wk.client,
    });
    const expected: ReadonlyArray<readonly [string, readonly string[]]> = [
      ["weeek_list_tasks", ["project_id", "per_page"]],
      ["weeek_get_task", ["task_id"]],
      ["weeek_get_project", ["project_id"]],
      ["weeek_list_boards", ["project_id"]],
      ["weeek_list_board_columns", ["board_id"]],
    ];
    for (const [name, props] of expected) {
      const shape = (srv.byName(name)?.config.inputSchema ?? {}) as Record<
        string,
        unknown
      >;
      for (const prop of props) {
        expect(shape[prop], `${name}.${prop} missing`).toBeDefined();
      }
    }
  });

  it("no camelCase alias survives the D4 rename (clean break, no dual intake)", () => {
    // The break is deliberate: a saved camelCase call must fail validation
    // loudly, not silently do nothing. If a future change re-adds an alias
    // "for compatibility", this fires.
    const srv = makeMockMcpServer();
    const wk = setupHappyClient();
    registerAllTools(srv.server, {
      config: makeSweepConfig(),
      weeek: wk.client,
    });
    const retired: ReadonlyArray<readonly [string, readonly string[]]> = [
      ["weeek_list_tasks", ["projectId", "perPage"]],
      ["weeek_get_task", ["id"]],
      ["weeek_get_project", ["projectId"]],
      ["weeek_list_boards", ["projectId"]],
      ["weeek_list_board_columns", ["boardId"]],
    ];
    for (const [name, props] of retired) {
      const shape = (srv.byName(name)?.config.inputSchema ?? {}) as Record<
        string,
        unknown
      >;
      for (const prop of props) {
        expect(shape[prop], `${name}.${prop} still accepted`).toBeUndefined();
      }
    }
  });

  it("tools/list payload (titles + descriptions + annotations) stays well under the MCP 25k-char cap (B13, I7-prep)", () => {
    // The MCP spec has no hard limit on tools/list size, but most clients
    // refuse a single response over ~25 000 chars (the typical token cap on
    // a single MCP message). Schemas are emitted by the SDK as JSON Schema
    // and add their own ~10–15 KB; keeping the *prose* portion (title +
    // description + annotations) small leaves a comfortable budget. This
    // catches G6-style description drift before it hits users.
    //
    // I8 (#43) added a per-tool allowance ALONGSIDE the absolute one. A flat
    // ceiling alone conflates two different regressions once the surface is
    // growing: "a description ran away" (what this test is for) and "the
    // server gained a tool" (intended, five times over in I8).
    //
    // The per-tool number is an allowance on the *mean*, and #47 raised it
    // from 620 to 660 because the mean moved for a structural reason rather
    // than a prose one: all five I8 additions are WRITE tools, and every write
    // tool has to carry ADR 0004 §5 "DISTINCT from" steering that no read tool
    // needs. Observed at the complete 15-tool surface: mean ~627, widest
    // ~812 (`weeek_create_task`, whose seven optionals each want a word), and
    // the newest addition sits at ~753 — inside the existing spread, not above
    // it. A single runaway description still trips 660.
    //
    // The absolute bound is now the tighter of the two (~9 550 of 10 000).
    //
    // The seal (#50) took the measurement this comment used to defer, and it
    // corrects the framing above: on the wire the 15-tool payload is ~37 600
    // chars, of which prose is only ~9 600 — the SDK-emitted JSON Schemas are
    // the other three quarters, and nothing here can see them. So this pair of
    // bounds is a *description-drift* detector, not the thing protecting a
    // client's cap. That measurement lives in
    // `tests/invariants/tools-list-wire.test.ts`, taken off a real
    // `tools/list` response, where the ~25 000 figure is also read as the
    // token budget it actually is.
    //
    // I9 (#63) moved both numbers again — 660 → 680 on the mean, 10 000 →
    // 10 100 absolute — for the same kind of structural reason #47 had. Two
    // write tools each gained a sentence naming a capability Weeek accepts and
    // silently drops, which is information an agent can get nowhere else: the
    // absence of an argument cannot say WHY it is absent. `weeek_update_task`
    // pays the most for it (~300 chars) because its two absences are different
    // in kind and the text must not flatten them into "Weeek cannot".
    // Observed after: total 9 958, mean ~664, widest ~1 006
    // (`weeek_update_task`). Both bounds sit just above that on purpose — the
    // next description addition should be a decision, not a rounding error —
    // and the absolute one stays the tighter of the two (9 958 of 10 100,
    // against 680 × 15 = 10 200).
    const srv = makeMockMcpServer();
    const wk = setupHappyClient();
    registerAllTools(srv.server, {
      config: makeSweepConfig(),
      weeek: wk.client,
    });
    const proseSurface = srv.registrations().map((r) => ({
      name: r.name,
      title: r.config.title ?? "",
      description: r.config.description ?? "",
      annotations: r.config.annotations ?? {},
    }));
    const proseChars = JSON.stringify(proseSurface).length;
    // Two bounds, because they catch different regressions. Per-tool catches
    // a description running away; the absolute one is the bound that actually
    // protects the client's token cap, and dropping it would let the surface
    // grow without limit as long as each tool stayed individually tidy.
    const PROSE_BUDGET_PER_TOOL = 680;
    const PROSE_BUDGET_TOTAL = 10_100;
    expect(proseChars).toBeLessThan(
      PROSE_BUDGET_PER_TOOL * proseSurface.length,
    );
    expect(proseChars).toBeLessThan(PROSE_BUDGET_TOTAL);
  });

  it("every tool's description carries a guidance fragment (PRIMARY|DISTINCT|Use when) — G6 in I7-prep", () => {
    // Style pass from competitor analysis §3.6 / D8: every description should
    // help an agent disambiguate similar tools. Tripwire fires when a future
    // tool ships with a bare functional description — forces author to add
    // at least one of "PRIMARY tool for…", "DISTINCT from…", or "Use when…".
    const srv = makeMockMcpServer();
    const wk = setupHappyClient();
    registerAllTools(srv.server, {
      config: makeSweepConfig(),
      weeek: wk.client,
    });
    for (const reg of srv.registrations()) {
      const desc = reg.config.description ?? "";
      expect(
        /PRIMARY tool for|DISTINCT from|Use when/.test(desc),
        `tool ${reg.name} description missing PRIMARY/DISTINCT/Use when guidance`,
      ).toBe(true);
    }
  });

  it("every write tool names the sibling writes it is confusable with (ADR 0004 §5, seal #50)", () => {
    // The gate above accepts ANY of PRIMARY / DISTINCT / Use when, so a write
    // tool could keep a "PRIMARY tool for…" opener, lose every word of its
    // disambiguation, and still pass it. That wording is the only thing
    // standing between an agent and the WRONG MUTATION — "move the card to
    // Done" firing `weeek_complete_task`, or an edit firing a move — so the
    // seal pins it per tool rather than leaving it to prose review.
    //
    // Each row is "this tool must name that tool". Deliberately asserted over
    // the registered description (what a client actually receives), not over
    // the source file: a steering sentence moved into an unused const would
    // pass a source grep and fail a user.
    const MUST_NAME: Record<string, readonly string[]> = {
      // A column IS a status in Weeek, so these three are the confusable set.
      weeek_complete_task: ["weeek_update_task", "weeek_move_task"],
      weeek_move_task: ["weeek_update_task", "weeek_complete_task"],
      weeek_update_task: ["weeek_move_task", "weeek_complete_task"],
      // Create is confusable with the edit tools in the other direction: an
      // agent reaching for "change this task" must not file a second one.
      weeek_create_task: ["weeek_update_task", "weeek_move_task"],
      // The MR-link write is a custom-field write, which the edit tool
      // cannot do at all.
      weeek_set_task_mr_link: ["weeek_update_task"],
    };
    expect(Object.keys(MUST_NAME).sort()).toEqual([...WRITE_TOOLS].sort());

    const srv = makeMockMcpServer();
    const wk = setupHappyClient();
    registerAllTools(srv.server, {
      config: makeSweepConfig(),
      weeek: wk.client,
    });
    for (const [tool, siblings] of Object.entries(MUST_NAME)) {
      const desc = srv.byName(tool)?.config.description ?? "";
      expect(desc, `${tool} lost its "DISTINCT from" steering`).toContain(
        "DISTINCT from",
      );
      for (const sibling of siblings) {
        expect(
          desc.includes(sibling),
          `${tool} no longer tells an agent how it differs from ${sibling}`,
        ).toBe(true);
      }
    }
  });

  it("a write tool whose capability is absent by design says so in its description (#63)", () => {
    // I9 (#63). Two edits Weeek accepts with a 200 and silently ignores —
    // `description` and the assignee list — are absent from
    // `weeek_update_task`'s input on purpose. Absence is the right *shape*,
    // but on its own it leaves an agent unable to tell "wrong tool" from
    // "wrong argument name" from "the API will not do this", so it guesses.
    // The explanation used to live only in a source comment and both READMEs;
    // neither is read over `tools/list`.
    //
    // Every write tool is accounted for below, in one bucket or the other. A
    // sixth write tool cannot be added without deciding which it belongs in —
    // which is the whole point of pinning the exempt list rather than only the
    // gated one.
    const MUST_STATE: Record<string, readonly (string | RegExp)[]> = {
      // The limit lives on both sides: the tool that cannot do it…
      weeek_update_task: [
        "description",
        "assignee",
        "silently",
        /Weeek[^.]*ignore/i,
        // …and a pointer to the tool that can.
        "weeek_create_task",
        // The two absences are different in kind and the text must not flatten
        // them: a description has no edit route at all, assignees have one
        // (add/remove, probe #46) this server has not built a tool for. A
        // description that said "Weeek cannot reassign" would pass every
        // fragment above and ship a competitor's known-false claim.
        /add\/remove route this server does not expose/,
      ],
      // …and the tool that can, which is where an agent asked to reassign an
      // existing task looks next.
      weeek_create_task: [/assignee list can ONLY be set here/],
    };
    // Reviewed under #63 and deliberately left alone. Not "nothing is absent"
    // — each has an absence, and each is already told to the agent somewhere
    // inside the surface rather than only in prose:
    //
    //   weeek_complete_task — flips one flag; the fields it will not touch are
    //     named in its own DISTINCT steering.
    //   weeek_move_task — a board without a column ("you pick where it lands")
    //     is unexpressible by schema, so the agent is told at validation time,
    //     and `board_column_id`'s own description says why.
    //   weeek_set_task_mr_link — cannot CREATE a custom field, only write one.
    //     That arrives as `WeeekMrFieldNotFoundError` with the remedy spelled
    //     out (ADR 0005 §3 rung 3), which is a stronger telling than a
    //     description line and costs the agent one call, not a guess.
    const REVIEWED_NO_CHANGE = [
      "weeek_complete_task",
      "weeek_move_task",
      "weeek_set_task_mr_link",
    ];
    expect(
      [...Object.keys(MUST_STATE), ...REVIEWED_NO_CHANGE].sort(),
      "a write tool is in neither bucket — decide whether it hides a limit",
    ).toEqual([...WRITE_TOOLS].sort());

    const srv = makeMockMcpServer();
    const wk = setupHappyClient();
    registerAllTools(srv.server, {
      config: makeSweepConfig(),
      weeek: wk.client,
    });
    for (const [tool, fragments] of Object.entries(MUST_STATE)) {
      const desc = srv.byName(tool)?.config.description ?? "";
      for (const fragment of fragments) {
        expect(
          typeof fragment === "string"
            ? desc.includes(fragment)
            : fragment.test(desc),
          `${tool} no longer states the limit an agent would otherwise find by trial (${String(fragment)})`,
        ).toBe(true);
      }
    }
  });

  it("every registered tool has a non-empty description (≥20 chars)", () => {
    const srv = makeMockMcpServer();
    const wk = setupHappyClient();
    registerAllTools(srv.server, {
      config: makeSweepConfig(),
      weeek: wk.client,
    });
    for (const reg of srv.registrations()) {
      const desc = reg.config.description ?? "";
      expect(desc.length).toBeGreaterThanOrEqual(20);
    }
  });

  it("every list/detail tool exposes truncated:z.ZodBoolean in its outputSchema", () => {
    const srv = makeMockMcpServer();
    const wk = setupHappyClient();
    registerAllTools(srv.server, {
      config: makeSweepConfig(),
      weeek: wk.client,
    });
    for (const name of TOOLS_WITH_TRUNCATION) {
      const reg = srv.byName(name);
      expect(reg, `expected ${name} to be registered`).toBeDefined();
      const shape = reg?.config.outputSchema as Record<string, unknown>;
      expect(shape["truncated"]).toBeInstanceOf(z.ZodBoolean);
    }
  });

  it("ping and weeek_get_me have NO `truncated` in outputSchema (not in STRATEGIES)", () => {
    const srv = makeMockMcpServer();
    const wk = setupHappyClient();
    registerAllTools(srv.server, {
      config: makeSweepConfig(),
      weeek: wk.client,
    });
    const ping = srv.byName("ping");
    const me = srv.byName("weeek_get_me");
    const pingShape = ping?.config.outputSchema as Record<string, unknown>;
    const meShape = me?.config.outputSchema as Record<string, unknown>;
    expect(pingShape["truncated"]).toBeUndefined();
    expect(meShape["truncated"]).toBeUndefined();
  });

  it("registered tool names match the registry's documented set (no drift)", () => {
    const srv = makeMockMcpServer();
    const wk = setupHappyClient();
    registerAllTools(srv.server, {
      config: makeSweepConfig(),
      weeek: wk.client,
    });
    const names = srv.registrations().map((r) => r.name);
    expect(names).toEqual([...ALL_TOOLS]);
  });

  it("the default surface is the read set alone — writes are opt-in (ADR 0004 §1)", () => {
    const srv = makeMockMcpServer();
    const wk = setupHappyClient();
    registerAllTools(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    expect(srv.registrations().map((r) => r.name)).toEqual([...READ_TOOLS]);
  });

  it("no handler writes to process.stdout (INVARIANT-1, happy + error paths)", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    // Happy path: every tool's success branch must not touch stdout.
    {
      const srv = makeMockMcpServer();
      const wk = setupHappyClient();
      registerAllTools(srv.server, {
        config: makeSweepConfig(),
        weeek: wk.client,
      });
      for (const call of HAPPY_CALLS) {
        await srv.callHandler(call.name, call.args);
      }
    }

    // Error path: every weeek tool's `isError: true` branch must also
    // stay clear of stdout (RETRO-04). `ping` is excluded — it never
    // reaches a Weeek client and has no catch block.
    {
      const srv = makeMockMcpServer();
      const wk = makeMockWeeekClient();
      wk.rejectAll(
        new WeeekError({
          code: "weeek_unauthorized",
          message: "synthetic",
          status: 401,
        }),
      );
      registerAllTools(srv.server, {
        config: makeSweepConfig(),
        weeek: wk.client,
      });
      for (const call of HAPPY_CALLS) {
        if (call.name === "ping") continue;
        await srv.callHandler(call.name, call.args);
      }
    }

    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("error path never logs sensitive ctx keys (INVARIANT-2b / INVARIANT-9)", async () => {
    const warnSpy = logger.warn as unknown as LoggerMethodSpy;
    const wk = makeMockWeeekClient();
    wk.rejectAll(
      new WeeekError({
        code: "weeek_unauthorized",
        message: "leak: anna@example.com Bearer xyz",
        status: 401,
      }),
    );
    const srv = makeMockMcpServer();
    registerAllTools(srv.server, {
      config: makeSweepConfig(),
      weeek: wk.client,
    });
    // Ping never reaches the network — exclude from this assertion.
    for (const call of HAPPY_CALLS) {
      if (call.name === "ping") continue;
      await srv.callHandler(call.name, call.args);
    }
    for (const c of warnSpy.mock.calls) {
      const ctx = c[1];
      if (ctx === undefined || ctx === null) continue;
      const ctxObj = ctx;
      // Only `code` and `status` should be on the context.
      const keys = Object.keys(ctxObj).map((k) => k.toLowerCase());
      expect(keys).not.toContain("authorization");
      expect(keys).not.toContain("token");
      expect(keys).not.toContain("email");
      expect(keys).not.toContain("title");
      expect(keys).not.toContain("description");
      // Value-side assertion (RETRO-05): even if a future regression
      // added a key like { message: err.message }, the serialised ctx
      // must not echo the seeded leak strings from the WeeekError
      // constructed above. This pins INVARIANT-9 at the value level,
      // not just the key-name level.
      const serialised = JSON.stringify(ctxObj);
      expect(serialised).not.toContain("anna@example.com");
      expect(serialised).not.toContain("Bearer xyz");
      expect(serialised).not.toContain("leak:");
    }
  });

  it("each handler returning isError:true emits '<tool> failed (<code>): <humanMessage>' (INVARIANT-7)", async () => {
    const wk = makeMockWeeekClient();
    const err = new WeeekError({
      code: "weeek_unauthorized",
      message: "weeek http 401",
      status: 401,
    });
    wk.rejectAll(err);
    const srv = makeMockMcpServer();
    registerAllTools(srv.server, {
      config: makeSweepConfig(),
      weeek: wk.client,
    });
    const expectedSentence = humanMessage(err);
    for (const call of HAPPY_CALLS) {
      if (call.name === "ping") continue;
      const out = (await srv.callHandler(call.name, call.args)) as {
        content?: Array<{ text?: string }>;
        isError?: boolean;
      };
      expect(out.isError).toBe(true);
      const text = out.content?.[0]?.text ?? "";
      expect(text).toMatch(/^[a-z_]+ failed \(weeek_[a-z_]+\): /);
      expect(text.startsWith(`${call.name} failed (weeek_unauthorized): `)).toBe(true);
      expect(text).toContain(expectedSentence);
    }
  });

  it("applyResponseLimits is non-mutating across all list/detail tool happy paths", async () => {
    const wk = setupHappyClient();
    const srv = makeMockMcpServer();
    registerAllTools(srv.server, {
      config: makeSweepConfig({ maxResponseChars: 2048 }),
      weeek: wk.client,
    });
    // Snapshot the original list bodies, run handlers, ensure originals
    // remain identical (deep-equal). Truncation must clone, never mutate.
    const before = JSON.stringify(HAPPY_BODIES);
    for (const call of HAPPY_CALLS) {
      await srv.callHandler(call.name, call.args);
    }
    const after = JSON.stringify(HAPPY_BODIES);
    expect(after).toBe(before);
  });

  it("truncated structuredContent still parses against each tool's outputSchema", async () => {
    const wk = makeMockWeeekClient();
    // Tasks: many wide rows so truncation kicks in.
    const wideTasks = Array.from({ length: 100 }, (_, i) =>
      makeTaskSummaryPayload({
        id: i + 1,
        title: "T".repeat(60),
      }),
    );
    const wideMembers = Array.from({ length: 100 }, (_, i) =>
      makeMemberPayload({
        id: `u-${String(i)}`,
        firstName: "fn".repeat(10),
        lastName: "ln".repeat(10),
      }),
    );
    const wideTags = Array.from({ length: 100 }, (_, i) =>
      makeTagPayload({ id: i + 1, title: "t".repeat(40) }),
    );
    const wideProjects = Array.from({ length: 100 }, (_, i) =>
      makeProjectPayload({ id: i + 1, title: "p".repeat(40) }),
    );
    wk.whenRequest("GET", `${WEEEK_PATH.tasksList}?perPage=20`, {
      status: 200,
      body: { ...makeEnvelope("tasks", wideTasks), hasMore: true },
    });
    wk.whenRequest("GET", WEEEK_PATH.projectsList, {
      status: 200,
      body: makeEnvelope("projects", wideProjects),
    });
    wk.whenRequest("GET", WEEEK_PATH.membersList, {
      status: 200,
      body: makeEnvelope("members", wideMembers),
    });
    wk.whenRequest("GET", WEEEK_PATH.tagsList, {
      status: 200,
      body: makeEnvelope("tags", wideTags),
    });
    wk.whenRequest("GET", WEEEK_PATH.taskById(1), {
      status: 200,
      body: makeEnvelope(
        "task",
        makeTaskDetailPayload({ id: 1, description: "x".repeat(50_000) }),
      ),
    });
    wk.whenRequest("GET", WEEEK_PATH.projectById(1), {
      status: 200,
      body: makeEnvelope(
        "project",
        makeProjectDetailPayload({ id: 1, description: "y".repeat(50_000) }),
      ),
    });
    const wideBoards = Array.from({ length: 100 }, (_, i) =>
      makeBoardPayload({
        id: i + 1,
        name: "B".repeat(60),
        projectId: 1,
      }),
    );
    const wideColumns = Array.from({ length: 100 }, (_, i) =>
      makeBoardColumnPayload({
        id: i + 1,
        name: "C".repeat(60),
        boardId: 1,
      }),
    );
    wk.whenRequest("GET", `${WEEEK_PATH.boardsList}?projectId=1`, {
      status: 200,
      body: makeEnvelope("boards", wideBoards),
    });
    wk.whenRequest("GET", `${WEEEK_PATH.boardColumnsList}?boardId=1`, {
      status: 200,
      body: makeEnvelope("boardColumns", wideColumns),
    });
    // The write leg's ack; its read-back reuses the wide-description task
    // seeded above, so the write payload overflows the budget too.
    wk.whenRequest("POST", WEEEK_PATH.taskComplete(1), {
      status: 200,
      body: { success: true },
    });
    const oversizedEcho = {
      status: 200,
      body: makeEnvelope(
        "task",
        makeTaskDetailPayload({ id: 1, description: "x".repeat(50_000) }),
      ),
    };
    wk.whenRequest("PUT", WEEEK_PATH.taskById(1), oversizedEcho);
    wk.whenRequest("POST", WEEEK_PATH.tasksList, oversizedEcho);
    // `weeek_set_task_mr_link` resolves its field by name before writing, so
    // its truncation case needs the listing leg as well as the oversized echo.
    wk.whenRequest("GET", WEEEK_PATH.customFieldsList, {
      status: 200,
      body: makeEnvelope("data", [makeCustomFieldPayload()]),
    });

    const srv = makeMockMcpServer();
    registerAllTools(srv.server, {
      config: makeSweepConfig({ maxResponseChars: 2048 }),
      weeek: wk.client,
    });

    for (const name of TOOLS_WITH_TRUNCATION) {
      const reg = srv.byName(name);
      const shape = reg?.config.outputSchema as z.ZodRawShape;
      const args = ARGS_FOR[name] ?? {};
      const out = (await srv.callHandler(name, args)) as {
        structuredContent: Record<string, unknown>;
      };
      expect(out.structuredContent["truncated"]).toBe(true);
      // Validate against the very schema the SDK would enforce post-handler.
      expect(() =>
        z.object(shape).parse(out.structuredContent),
      ).not.toThrow();
    }
  });
});
