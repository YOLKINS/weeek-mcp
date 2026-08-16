import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { registerWeeekSetTaskMrLinkTool } from "../../../src/tools/tasks/setTaskMrLink.tool.js";
import { MR_LINK_FIELD_NAMES } from "../../../src/weeek/endpoints.js";
import { WeeekError } from "../../../src/weeek/types.js";
import { humanMessage } from "../../../src/weeek/humanMessage.js";
import { logger } from "../../../src/logging/logger.js";
import type { LoggerMethodSpy } from "../../helpers/spies.js";
import {
  makeCustomFieldPayload,
  makeEnvConfig,
  makeEnvelope,
  makeTaskDetailPayload,
  FIXTURE_MR_FIELD_UUID,
} from "../../helpers/factories.js";
import { makeMockMcpServer } from "../../helpers/mockMcpServer.js";
import { makeMockWeeekClient } from "../../helpers/mockWeeekClient.js";
import { WEEEK_PATH } from "../../helpers/paths.js";

const MARKER = "…[truncated]";
const MR_URL = "https://github.com/acme/api/pull/17";
const MINIMAL = { task_id: 1, mr_url: MR_URL };

// The by-name happy path: the custom-fields listing the resolver reads, then
// the task PUT that carries the map body.
function seedByName(
  fields: Array<Record<string, unknown>> = [makeCustomFieldPayload()],
  taskOverrides: Record<string, unknown> = {},
): ReturnType<typeof makeMockWeeekClient> {
  const wk = makeMockWeeekClient();
  wk.whenRequest("GET", WEEEK_PATH.customFieldsList, {
    status: 200,
    body: makeEnvelope("data", fields),
  });
  wk.whenRequest("PUT", WEEEK_PATH.taskById(1), {
    status: 200,
    body: makeEnvelope("task", makeTaskDetailPayload({ id: 1, ...taskOverrides })),
  });
  return wk;
}

function register(
  wk: ReturnType<typeof makeMockWeeekClient>,
  config = makeEnvConfig(),
): ReturnType<typeof makeMockMcpServer> {
  const srv = makeMockMcpServer();
  registerWeeekSetTaskMrLinkTool(srv.server, { config, weeek: wk.client });
  return srv;
}

function inputShape(
  srv: ReturnType<typeof makeMockMcpServer>,
): Record<string, z.ZodTypeAny> {
  return srv.byName("weeek_set_task_mr_link")?.config.inputSchema as Record<
    string,
    z.ZodTypeAny
  >;
}

function putBody(
  wk: ReturnType<typeof makeMockWeeekClient>,
): Record<string, unknown> {
  const put = wk.requests().find((r) => r.method === "PUT");
  return (put && "body" in put ? put.body : {}) as Record<string, unknown>;
}

async function textOf(
  srv: ReturnType<typeof makeMockMcpServer>,
  args: Record<string, unknown>,
): Promise<string> {
  const out = (await srv.callHandler("weeek_set_task_mr_link", args)) as {
    content: Array<{ text: string }>;
  };
  return out.content[0]?.text ?? "";
}

describe("registerWeeekSetTaskMrLinkTool", () => {
  beforeEach(() => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "info").mockImplementation(() => {});
  });

  it("declares the write annotation profile (INVARIANT-12 marker + ADR 0005 §5)", () => {
    const srv = register(makeMockWeeekClient());
    expect(
      srv.byName("weeek_set_task_mr_link")?.config.annotations,
    ).toMatchObject({
      readOnlyHint: false,
      // One dedicated slot set to an explicit value, reversible by re-setting
      // — not the arbitrary-field edit that makes update_task confirm-worthy.
      destructiveHint: false,
      // Re-firing the same call lands the same state.
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it("says it writes ONLY the MR-link field, and steers away from the field edit", () => {
    const desc =
      srv0().byName("weeek_set_task_mr_link")?.config.description ?? "";
    expect(desc).toContain("DISTINCT from");
    expect(desc).toContain("weeek_update_task");
    expect(desc.toLowerCase()).toContain("only");
  });

  it("publishes the candidate field names it actually matches", () => {
    // The description is where an operator learns what to call their field.
    // Driving the assertion off the exported constant is what stops the
    // published list from drifting from the one the resolver matches.
    const desc =
      srv0().byName("weeek_set_task_mr_link")?.config.description ?? "";
    for (const name of MR_LINK_FIELD_NAMES) {
      expect(desc, `candidate '${name}' unpublished`).toContain(name);
    }
  });

  it("exposes four inputs; only task_id and mr_url are required", () => {
    const shape = inputShape(srv0());
    expect(Object.keys(shape).sort()).toEqual([
      "custom_field_id",
      "custom_field_name",
      "mr_url",
      "task_id",
    ]);
    const required = Object.entries(shape)
      .filter(([, v]) => !v.isOptional())
      .map(([k]) => k)
      .sort();
    expect(required).toEqual(["mr_url", "task_id"]);
  });

  it("no other task field is expressible here (ADR 0005 §2 — a disjoint body key)", () => {
    const shape = inputShape(srv0());
    for (const forbidden of [
      "title",
      "description",
      "priority",
      "due_date",
      "board_id",
      "board_column_id",
      "completed",
    ]) {
      expect(shape[forbidden], `${forbidden} must not be expressible`).toBeUndefined();
    }
  });

  it("custom_field_id is a UUID STRING — an integer id is rejected", () => {
    // Every other id on this surface is an integer; this one is not (probe
    // #12). A tool that accepted a number here would build a map keyed by a
    // stringified integer and get a 200 that changed nothing.
    const field = inputShape(srv0())["custom_field_id"] ?? z.never();
    expect(field.parse(FIXTURE_MR_FIELD_UUID)).toBe(FIXTURE_MR_FIELD_UUID);
    expect(() => {
      field.parse(42);
    }).toThrow();
    expect(() => {
      field.parse("42");
    }).toThrow();
  });

  it("mr_url must be an http(s) URL — a bare word is not a link", () => {
    const field = inputShape(srv0())["mr_url"] ?? z.never();
    expect(field.parse(MR_URL)).toBe(MR_URL);
    expect(() => {
      field.parse("see the MR");
    }).toThrow();
    expect(() => {
      field.parse("javascript:alert(1)");
    }).toThrow();
  });

  it("writes a MAP keyed by field id — the recorded body, not the status code", async () => {
    // The single most important assertion of #47. The array shape
    // (`customFields: [{id, value}]`) returns 200 and silently discards the
    // value, so a test that asserted "the call succeeded" would pass against
    // a tool that wrote nothing at all.
    const wk = seedByName();
    const srv = register(wk);
    await srv.callHandler("weeek_set_task_mr_link", MINIMAL);
    expect(putBody(wk)).toStrictEqual({
      customFields: { [FIXTURE_MR_FIELD_UUID]: MR_URL },
    });
    expect(Array.isArray(putBody(wk)["customFields"])).toBe(false);
  });

  it("resolves by name when only a name is available: listing, then write", async () => {
    const wk = seedByName();
    const srv = register(wk);
    await srv.callHandler("weeek_set_task_mr_link", MINIMAL);
    expect(wk.requests().map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET ${WEEEK_PATH.customFieldsList}`,
      `PUT ${WEEEK_PATH.taskById(1)}`,
    ]);
  });

  it("with custom_field_id supplied, NO listing request is issued", async () => {
    const wk = makeMockWeeekClient();
    wk.whenRequest("PUT", WEEEK_PATH.taskById(1), {
      status: 200,
      body: makeEnvelope("task", makeTaskDetailPayload({ id: 1 })),
    });
    const srv = register(wk);
    const out = (await srv.callHandler("weeek_set_task_mr_link", {
      ...MINIMAL,
      custom_field_id: FIXTURE_MR_FIELD_UUID,
    })) as { isError?: boolean };
    expect(out.isError).toBeFalsy();
    expect(wk.requests().map((r) => r.method)).toEqual(["PUT"]);
  });

  it("custom_field_name overrides the candidate list", async () => {
    const wk = seedByName([
      makeCustomFieldPayload({ name: "MR link" }),
      makeCustomFieldPayload({
        id: "7e2a55f0-1111-4222-8333-000000000009",
        name: "Code review",
      }),
    ]);
    const srv = register(wk);
    await srv.callHandler("weeek_set_task_mr_link", {
      ...MINIMAL,
      custom_field_name: "code review",
    });
    expect(putBody(wk)).toStrictEqual({
      customFields: { "7e2a55f0-1111-4222-8333-000000000009": MR_URL },
    });
  });

  it("nothing resolves → a clean tool error, and NO write request", async () => {
    const wk = seedByName([makeCustomFieldPayload({ name: "Estimate" })]);
    const srv = register(wk);
    const out = (await srv.callHandler(
      "weeek_set_task_mr_link",
      MINIMAL,
    )) as { content: Array<{ text: string }>; isError?: boolean };
    expect(out.isError).toBe(true);
    expect(wk.requests().map((r) => r.method)).toEqual(["GET"]);
    const text = out.content[0]?.text ?? "";
    expect(text).toMatch(
      /^weeek_set_task_mr_link failed \(weeek_validation_error\): /,
    );
    // Never claims Weeek rejected it — Weeek never saw a write.
    expect(text).toContain("The request was not sent");
    expect(text).not.toContain("HTTP 400/422");
    // Says what would fix it: name the field, or have one created.
    expect(text).toContain("custom_field_id");
    expect(text).toContain("custom_field_name");
    // …and the plan-tier caveat, which is the other reason a tenant has none.
    expect(text.toLowerCase()).toContain("plan");
  });

  it("an ambiguous match errors instead of picking one, and writes nothing", async () => {
    const wk = seedByName([
      makeCustomFieldPayload({ name: "MR link" }),
      makeCustomFieldPayload({
        id: "7e2a55f0-1111-4222-8333-000000000009",
        name: "PR link",
      }),
    ]);
    const srv = register(wk);
    const out = (await srv.callHandler(
      "weeek_set_task_mr_link",
      MINIMAL,
    )) as { content: Array<{ text: string }>; isError?: boolean };
    expect(out.isError).toBe(true);
    expect(wk.requests().map((r) => r.method)).toEqual(["GET"]);
    const text = out.content[0]?.text ?? "";
    expect(text).toContain("more than one");
    expect(text).toContain("custom_field_id");
  });

  it("no error text names a workspace custom field (INVARIANT-2 / -9)", async () => {
    const wk = seedByName([
      makeCustomFieldPayload({ name: "Kingfisher MR" }),
      makeCustomFieldPayload({
        id: "7e2a55f0-1111-4222-8333-000000000009",
        name: "kingfisher mr",
      }),
    ]);
    const srv = register(wk);
    const text = await textOf(srv, {
      ...MINIMAL,
      custom_field_name: "Kingfisher MR",
    });
    expect(text).not.toContain("Kingfisher");
  });

  it("returns the task-detail output surface (same shape weeek_get_task returns)", () => {
    const shape = srv0().byName("weeek_set_task_mr_link")?.config
      .outputSchema as Record<string, unknown>;
    expect(Object.keys(shape).sort()).toEqual([
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
    ]);
  });

  it("happy: structuredContent carries the resulting task + truncated:false", async () => {
    const wk = seedByName(undefined, { title: "ship the parser" });
    const srv = register(wk);
    const out = (await srv.callHandler("weeek_set_task_mr_link", MINIMAL)) as {
      content: Array<{ text: string }>;
      structuredContent: Record<string, unknown>;
    };
    expect(out.structuredContent["id"]).toBe(1);
    expect(out.structuredContent["title"]).toBe("ship the parser");
    expect(out.structuredContent["truncated"]).toBe(false);
    expect(out.content[0]?.text).toContain("#1");
  });

  it("WeeekError → isError:true with the standard prefix + sentence (INVARIANT-7)", async () => {
    const wk = makeMockWeeekClient();
    const err = new WeeekError({
      code: "weeek_not_found",
      message: "weeek http 404",
      status: 404,
    });
    wk.rejectAll(err);
    const srv = register(wk);
    const out = (await srv.callHandler("weeek_set_task_mr_link", MINIMAL)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(out.isError).toBe(true);
    const text = out.content[0]?.text ?? "";
    expect(text).toMatch(
      /^weeek_set_task_mr_link failed \(weeek_not_found\): /,
    );
    expect(text).toContain(humanMessage(err));
  });

  it("error text never echoes body fragments; warn ctx is code+status only (INVARIANT-9)", async () => {
    const warnSpy = logger.warn as unknown as LoggerMethodSpy;
    const wk = makeMockWeeekClient();
    wk.rejectAll(
      new WeeekError({
        code: "weeek_forbidden",
        message: "leak: field name=top-secret-launch",
        status: 403,
      }),
    );
    const srv = register(wk);
    const text = await textOf(srv, MINIMAL);
    expect(text).not.toContain("top-secret-launch");
    const ctx = warnSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(ctx).sort()).toEqual(["code", "status"]);
  });

  it("an unparseable 2xx echo says the LINK landed and points at the read", async () => {
    const wk = makeMockWeeekClient();
    wk.whenRequest("PUT", WEEEK_PATH.taskById(1), {
      status: 200,
      body: { success: true },
    });
    const srv = register(wk);
    const text = await textOf(srv, {
      ...MINIMAL,
      custom_field_id: FIXTURE_MR_FIELD_UUID,
    });
    expect(text).toMatch(
      /^weeek_set_task_mr_link failed \(weeek_invalid_response\): /,
    );
    expect(text).toContain("WAS written");
    expect(text).toContain("weeek_get_task");
  });

  it("a rejected write carries NO landed-write note", async () => {
    const wk = makeMockWeeekClient();
    wk.whenRequest("PUT", WEEEK_PATH.taskById(1), {
      status: 422,
      body: { success: false },
    });
    const srv = register(wk);
    const text = await textOf(srv, {
      ...MINIMAL,
      custom_field_id: FIXTURE_MR_FIELD_UUID,
    });
    expect(text).not.toContain("WAS written");
  });

  it("an unresolved field carries NO landed-write note either", async () => {
    // All three notes ride the one shared error leg; a resolution failure must
    // not pick up "the link WAS written" from the landed branch.
    const wk = seedByName([]);
    const srv = register(wk);
    const text = await textOf(srv, MINIMAL);
    expect(text).not.toContain("WAS written");
  });

  it("non-WeeekError rejections propagate untouched (INVARIANT-6 boundary)", async () => {
    const wk = makeMockWeeekClient();
    wk.rejectAll(new Error("non-weeek failure"));
    const srv = register(wk);
    await expect(
      srv.callHandler("weeek_set_task_mr_link", MINIMAL),
    ).rejects.toThrow(/non-weeek/);
  });

  it("the byte-budget gate is wired: a long description clips and sets truncated", async () => {
    const wk = seedByName(undefined, { description: "x".repeat(50_000) });
    const srv = register(wk, makeEnvConfig({ maxResponseChars: 2048 }));
    const out = (await srv.callHandler("weeek_set_task_mr_link", MINIMAL)) as {
      structuredContent: { description: string; truncated: boolean };
    };
    expect(out.structuredContent.truncated).toBe(true);
    expect(out.structuredContent.description.endsWith(MARKER)).toBe(true);
  });
});

// Schema-only assertions need no seeded transport; one helper keeps them from
// each hand-rolling an empty client.
function srv0(): ReturnType<typeof makeMockMcpServer> {
  return register(makeMockWeeekClient());
}
