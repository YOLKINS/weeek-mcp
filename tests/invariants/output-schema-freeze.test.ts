import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { registerAllTools } from "../../src/tools/registry.js";
import { logger } from "../../src/logging/logger.js";
import { makeEnvConfig } from "../helpers/factories.js";
import { makeMockMcpServer } from "../helpers/mockMcpServer.js";
import { makeMockWeeekClient } from "../helpers/mockWeeekClient.js";
import { ALL_TOOLS, WRITE_TOOLS } from "../helpers/toolNames.js";

// Gate B (ADR 0003 / spec #32) — the narrow-refactor line. I7.5 makes every
// read parser tolerant of inner-field drift WITHOUT changing any tool's
// `outputSchema`: a drifted string still yields a string (`""`), a drifted
// array still yields an array (`[]`). This guardrail locks the full read-tool
// surface as a snapshot *before* any parser migration (#34–#37), so a
// migration that silently widens or narrows a tool's declared shape fails
// here. Snapshot the client-observable structure of every registered tool's
// `outputSchema`; a diff means the surface moved.
//
// The fingerprint is deliberately self-contained (no `zod-to-json-schema`
// dependency — that ships transitively under the SDK and could change or
// vanish on an SDK bump): it walks the zod schema and records typeName +
// description + nested structure + numeric/string checks, which is exactly the
// surface a migration could accidentally move.

interface ZodCheckLike {
  readonly kind: string;
  readonly value?: number;
}

interface ZodDefLike {
  readonly typeName: string;
  readonly checks?: readonly ZodCheckLike[];
  readonly type?: z.ZodTypeAny; // ZodArray element
  readonly innerType?: z.ZodTypeAny; // ZodOptional / ZodNullable
  readonly options?: readonly z.ZodTypeAny[]; // ZodUnion
  readonly shape?: () => z.ZodRawShape; // ZodObject
}

function fingerprint(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as unknown as ZodDefLike;
  const out: Record<string, unknown> = { type: def.typeName };
  const desc = schema.description;
  if (desc !== undefined) out["description"] = desc;
  switch (def.typeName) {
    case "ZodString":
    case "ZodNumber": {
      const checks = def.checks ?? [];
      if (checks.length > 0) {
        out["checks"] = checks
          .map((c) => ({ kind: c.kind, value: c.value }))
          .sort((a, b) => a.kind.localeCompare(b.kind));
      }
      break;
    }
    case "ZodArray":
      if (def.type) out["element"] = fingerprint(def.type);
      break;
    case "ZodObject":
      if (def.shape) out["shape"] = fingerprintShape(def.shape());
      break;
    case "ZodUnion":
      if (def.options) out["options"] = def.options.map((o) => fingerprint(o));
      break;
    case "ZodNullable":
    case "ZodOptional":
      if (def.innerType) out["inner"] = fingerprint(def.innerType);
      break;
    default:
      break;
  }
  return out;
}

function fingerprintShape(shape: z.ZodRawShape): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(shape).sort()) {
    const field = shape[key];
    if (field) out[key] = fingerprint(field);
  }
  return out;
}

function toolSurface(): Record<string, unknown> {
  // `readOnly: false` since the I8 seal (#50): the frozen surface is every
  // tool the server can expose, not only the ones the default install shows.
  // A write tool returns the task-detail shape a read returns, so leaving the
  // five outside the freeze would have left the shared
  // `taskDetailOutputShape` pinned through `weeek_get_task` alone — and a
  // write tool that drifted onto its own copy of it would not fail anything.
  const srv = makeMockMcpServer();
  registerAllTools(srv.server, {
    config: makeEnvConfig({ readOnly: false }),
    weeek: makeMockWeeekClient().client,
  });
  const surface: Record<string, unknown> = {};
  for (const reg of srv.registrations()) {
    const shape = reg.config.outputSchema as z.ZodRawShape | undefined;
    surface[reg.name] = shape ? fingerprintShape(shape) : null;
  }
  return surface;
}

describe("Gate B — outputSchema freeze (I7.5, ADR 0003; widened to the writes in I8 #50)", () => {
  beforeEach(() => {
    // Registration under `readOnly: false` logs nothing per tool, but the
    // spy stays: a config change back to the gated form would otherwise
    // dump 5 `tool gated by READ_ONLY` lines into the reporter.
    vi.spyOn(logger, "info").mockImplementation(() => {});
  });

  it("all 15 tools are present in the frozen surface — 10 reads + 5 writes", () => {
    const surface = toolSurface();
    expect(Object.keys(surface).sort()).toEqual([...ALL_TOOLS].sort());
    expect(Object.keys(surface)).toHaveLength(15);
  });

  it("every tool's outputSchema matches the locked baseline (fails on any change)", () => {
    // Baseline is written on first run and committed — it is the pre-I7.5
    // surface. Migrations #34–#37 must keep it byte-identical.
    expect(toolSurface()).toMatchSnapshot();
  });

  it("output property NAMES are pinned independently of their descriptions (D4, #41)", () => {
    // The snapshot above covers names AND descriptions, so a deliberate
    // prose edit (D4 reworded four `truncated` descriptions that quoted a
    // now-renamed input) requires regenerating it — which would also hide
    // an accidental *name* move landing in the same commit. This assertion
    // is name-only: outputs stay camelCase, matching the upstream API an
    // agent correlates against, no matter what the inputs are called.
    const surface = toolSurface() as Record<
      string,
      Record<string, unknown>
    >;
    // `weeek_get_task` and all five write tools share one declared shape
    // (`taskDetailOutputShape`), which is the promise "a write hands back the
    // task in the shape a read hands it back". Spelled once, asserted per
    // tool — a write tool that forked its own copy fails on the first field
    // that differs.
    const TASK_DETAIL_NAMES = [
      "assignees",
      "completed",
      "description",
      "id",
      "priority",
      "projectId",
      "title",
      "truncated",
      "type",
      "userId",
    ] as const;
    const names: Record<string, readonly string[]> = {
      ping: ["reply"],
      weeek_get_me: ["email", "id", "name"],
      weeek_get_project: [
        "color",
        "description",
        "id",
        "isPrivate",
        "title",
        "truncated",
      ],
      weeek_get_task: TASK_DETAIL_NAMES,
      weeek_list_board_columns: ["boardColumns", "truncated"],
      weeek_list_boards: ["boards", "truncated"],
      weeek_list_members: ["members", "truncated"],
      weeek_list_projects: ["projects", "truncated"],
      weeek_list_tags: ["tags", "truncated"],
      weeek_list_tasks: ["hasMore", "tasks", "truncated"],
      ...Object.fromEntries(WRITE_TOOLS.map((n) => [n, TASK_DETAIL_NAMES])),
    };
    // Guard the guard: this map is hand-written, and a tool absent from it
    // would be silently unasserted rather than failing.
    expect(Object.keys(names).sort()).toEqual([...ALL_TOOLS].sort());
    for (const [tool, expected] of Object.entries(names)) {
      expect(Object.keys(surface[tool] ?? {}).sort(), tool).toEqual([
        ...expected,
      ]);
    }
  });

  it("every write tool declares the SAME shape weeek_get_task does, field for field", () => {
    // Names alone would not catch a write tool that kept the ten field names
    // but declared `priority` non-nullable or dropped a description. The
    // fingerprint carries types, nullability and prose, so this compares the
    // whole declared shape — the one thing an agent relies on when it treats
    // a write's return value as a task it can read.
    const surface = toolSurface();
    for (const name of WRITE_TOOLS) {
      expect(surface[name], name).toEqual(surface["weeek_get_task"]);
    }
  });
});
