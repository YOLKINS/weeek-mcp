import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { registerWeeekUpdateTaskTool } from "../../../src/tools/tasks/updateTask.tool.js";
import { WeeekError } from "../../../src/weeek/types.js";
import { humanMessage } from "../../../src/weeek/humanMessage.js";
import { logger } from "../../../src/logging/logger.js";
import type { LoggerMethodSpy } from "../../helpers/spies.js";
import {
  makeEnvConfig,
  makeEnvelope,
  makeTaskDetailPayload,
} from "../../helpers/factories.js";
import { makeMockMcpServer } from "../../helpers/mockMcpServer.js";
import { makeMockWeeekClient } from "../../helpers/mockWeeekClient.js";
import { WEEEK_PATH } from "../../helpers/paths.js";

const MARKER = "…[truncated]";
const MINIMAL = { task_id: 1, title: "corrected" };

function seedEcho(
  id: number,
  overrides: Record<string, unknown> = {},
): ReturnType<typeof makeMockWeeekClient> {
  const wk = makeMockWeeekClient();
  wk.whenRequest("PUT", WEEEK_PATH.taskById(id), {
    status: 200,
    body: makeEnvelope("task", makeTaskDetailPayload({ id, ...overrides })),
  });
  return wk;
}

function register(
  wk: ReturnType<typeof makeMockWeeekClient>,
  config = makeEnvConfig(),
): ReturnType<typeof makeMockMcpServer> {
  const srv = makeMockMcpServer();
  registerWeeekUpdateTaskTool(srv.server, { config, weeek: wk.client });
  return srv;
}

function inputShape(
  srv: ReturnType<typeof makeMockMcpServer>,
): Record<string, z.ZodTypeAny> {
  return srv.byName("weeek_update_task")?.config.inputSchema as Record<
    string,
    z.ZodTypeAny
  >;
}

function bodyOf(wk: ReturnType<typeof makeMockWeeekClient>): Record<
  string,
  unknown
> {
  const req = wk.requests()[0];
  return (req && "body" in req ? req.body : {}) as Record<string, unknown>;
}

describe("registerWeeekUpdateTaskTool", () => {
  beforeEach(() => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "info").mockImplementation(() => {});
  });

  it("declares the write annotation profile (INVARIANT-12 marker + ADR 0004 §2)", () => {
    const srv = register(makeMockWeeekClient());
    expect(srv.byName("weeek_update_task")?.config.annotations).toMatchObject({
      readOnlyHint: false,
      // Editing the wrong task's title is not something the agent can undo —
      // it never saw the old value.
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it("steers away from the move and completion tools (ADR 0004 §5)", () => {
    const srv = register(makeMockWeeekClient());
    const desc = srv.byName("weeek_update_task")?.config.description ?? "";
    expect(desc).toContain("DISTINCT from");
    expect(desc).toContain("weeek_move_task");
    expect(desc).toContain("weeek_complete_task");
  });

  it("names the two edits Weeek accepts and silently drops (#63)", () => {
    // The absent fields are a structural guarantee, but an agent that finds no
    // `assignees` argument cannot tell "wrong tool" from "wrong argument name"
    // from "the API will not do this" — so the description says which it is.
    // Asserted over the registered text (what a client receives), like the
    // steering gate above, not over the source file.
    const srv = register(makeMockWeeekClient());
    const desc = srv.byName("weeek_update_task")?.config.description ?? "";
    expect(desc).toContain("description");
    expect(desc).toContain("assignee");
    // The limit is Weeek's, and the failure mode is the silent one.
    expect(desc).toMatch(/Weeek[^.]*ignore/i);
    expect(desc).toContain("silently");
    // Where the fields ARE settable — an agent told only "no" burns a turn
    // looking for the tool that says yes.
    expect(desc).toContain("weeek_create_task");
  });

  it("the input surface is disjoint from its neighbours' — no board, column, completion or custom field", () => {
    // The acceptance criterion of #46, and the reason it is worth a test of
    // its own: an agent that tries to "update the task's column" finds no
    // argument for it and has to go find the tool that has one. That is a
    // structural guarantee; description wording is only a hint.
    const shape = inputShape(register(makeMockWeeekClient()));
    for (const forbidden of [
      "board_id",
      "board_column_id",
      "completed",
      "is_completed",
      "custom_fields",
      "mr_link",
      "project_id",
    ]) {
      expect(shape[forbidden], `${forbidden} must not be expressible`).toBeUndefined();
    }
  });

  it("exposes exactly the four probe-confirmed editable fields, plus task_id", () => {
    // `description` and `assignees` are absent ON PURPOSE (probe #46): the API
    // accepts either with a 200 and silently ignores it, so offering them
    // would be a tool that reports success for an edit that never happened.
    const srv = register(makeMockWeeekClient());
    expect(Object.keys(inputShape(srv)).sort()).toEqual([
      "due_date",
      "priority",
      "task_id",
      "title",
      "type",
    ]);
  });

  it("task_id is the only required input; every editable field is optional", () => {
    const shape = inputShape(register(makeMockWeeekClient()));
    const required = Object.entries(shape)
      .filter(([, v]) => !v.isOptional())
      .map(([k]) => k);
    expect(required).toEqual(["task_id"]);
  });

  it("an empty title is rejected by the schema, not sent as a blanking edit", () => {
    // Probe #46: `PUT {title: ""}` answers 200 and stores `title: null`,
    // silently blanking the card. The schema is the only thing between an
    // agent's empty string and an untitled task.
    const title =
      inputShape(register(makeMockWeeekClient()))["title"] ?? z.never();
    expect(() => {
      title.parse("");
    }).toThrow();
    expect(() => {
      title.parse("   ");
    }).toThrow();
    expect(title.parse("ok")).toBe("ok");
  });

  it("type is the documented enum — an invented kind cannot be sent", () => {
    const type =
      inputShape(register(makeMockWeeekClient()))["type"] ?? z.never();
    for (const ok of ["action", "meet", "call"]) {
      expect(type.parse(ok)).toBe(ok);
    }
    expect(() => {
      type.parse("epic");
    }).toThrow();
  });

  it("a call naming one field sends only that field", async () => {
    const wk = seedEcho(1);
    const srv = register(wk);
    await srv.callHandler("weeek_update_task", MINIMAL);
    const req = wk.requests()[0];
    expect(req?.method).toBe("PUT");
    expect(req?.path).toBe(WEEEK_PATH.taskById(1));
    // `toStrictEqual`: `toEqual` would ignore a stray `priority: undefined`,
    // which is the exact regression that would start clobbering fields the
    // agent never mentioned.
    expect(req && "body" in req ? req.body : undefined).toStrictEqual({
      title: "corrected",
    });
  });

  it("snake_case in, upstream camelCase out (INVARIANT-13 seam)", async () => {
    const wk = seedEcho(1);
    const srv = register(wk);
    await srv.callHandler("weeek_update_task", {
      task_id: 1,
      title: "corrected",
      priority: 2,
      type: "meet",
      due_date: "2026-12-31",
    });
    expect(bodyOf(wk)).toStrictEqual({
      title: "corrected",
      priority: 2,
      type: "meet",
      dueDate: "2026-12-31",
    });
  });

  it.each([
    ["title", { title: "t" }, "title"],
    ["priority", { priority: 3 }, "priority"],
    ["type", { type: "call" }, "type"],
    ["due_date", { due_date: "2026-01-01" }, "dueDate"],
  ])(
    "%s alone reaches the wire, and nothing else does",
    async (_label, supplied, wireKey) => {
      const wk = seedEcho(1);
      const srv = register(wk);
      await srv.callHandler("weeek_update_task", { task_id: 1, ...supplied });
      expect(Object.keys(bodyOf(wk))).toEqual([wireKey]);
    },
  );

  it("priority 0 is Low, not unset — the falsy value reaches the wire", async () => {
    const wk = seedEcho(1);
    const srv = register(wk);
    await srv.callHandler("weeek_update_task", { task_id: 1, priority: 0 });
    expect(bodyOf(wk)).toStrictEqual({ priority: 0 });
  });

  it.each([
    ["due_date", { due_date: null }, "dueDate"],
    ["priority", { priority: null }, "priority"],
  ])(
    "%s: null clears the field — the one way to take a value back off a task",
    async (_label, supplied, wireKey) => {
      // Probe #46f confirmed `PUT` treats an explicit null as "unset this".
      // Without it an agent could set a due date and never remove it, which is
      // a capability the API has and the tool would not.
      const wk = seedEcho(1);
      const srv = register(wk);
      await srv.callHandler("weeek_update_task", { task_id: 1, ...supplied });
      expect(bodyOf(wk)).toStrictEqual({ [wireKey]: null });
    },
  );

  it("a clear-only call is a real edit, not an empty one", async () => {
    const wk = seedEcho(1);
    const srv = register(wk);
    const out = (await srv.callHandler("weeek_update_task", {
      task_id: 1,
      due_date: null,
    })) as { isError?: boolean };
    expect(wk.requests()).toHaveLength(1);
    expect(out.isError).toBeFalsy();
  });

  it("title and type reject null — neither has an 'unset' state", () => {
    // A null title is accepted upstream and BLANKS the card (probe #46), and
    // a null type is ignored outright (probe #46f). Only the two fields that
    // genuinely clear are nullable; the rest would be traps.
    const shape = inputShape(register(makeMockWeeekClient()));
    for (const field of ["title", "type"]) {
      expect(() => {
        (shape[field] ?? z.never()).parse(null);
      }, `${field} must not accept null`).toThrow();
    }
    for (const field of ["priority", "due_date"]) {
      expect((shape[field] ?? z.never()).parse(null)).toBeNull();
    }
  });

  it("an update naming NO field records not one request on the client", async () => {
    // #46's headline acceptance criterion, and stronger than asserting
    // `isError: true`: the mock counts requests, so a guard that moved
    // downstream of `client.request` — or a schema that let the empty call
    // through to a 200-no-op `PUT` — fails here even though the tool would
    // still be returning an error.
    const wk = seedEcho(1);
    const srv = register(wk);
    const out = (await srv.callHandler("weeek_update_task", {
      task_id: 1,
    })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(wk.requests()).toEqual([]);
    expect(out.isError).toBe(true);
  });

  it("the empty-update error names the fields that would make the call valid", async () => {
    const wk = seedEcho(1);
    const srv = register(wk);
    const out = (await srv.callHandler("weeek_update_task", {
      task_id: 1,
    })) as { content: Array<{ text: string }> };
    const text = out.content[0]?.text ?? "";
    // INVARIANT-7's prefix is unchanged — a local refusal is still a tool
    // error in the standard shape.
    expect(text).toMatch(
      /^weeek_update_task failed \(weeek_validation_error\): /,
    );
    // The sentence must not claim Weeek rejected anything: it never saw this
    // call. `humanMessage` owns that half…
    expect(text).toContain("The request was not sent");
    expect(text).not.toContain("HTTP 400/422");
    // …and the tool's note owns the half only it knows — which arguments
    // would have made the call valid.
    for (const field of ["title", "priority", "type", "due_date"]) {
      expect(text).toContain(field);
    }
  });

  it("returns the task-detail output surface (same shape weeek_get_task returns)", () => {
    const srv = register(makeMockWeeekClient());
    const shape = srv.byName("weeek_update_task")?.config
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

  it("happy: structuredContent carries the RESULTING task + truncated:false", async () => {
    const wk = seedEcho(1, { title: "corrected" });
    const srv = register(wk);
    const out = (await srv.callHandler("weeek_update_task", MINIMAL)) as {
      content: Array<{ text: string }>;
      structuredContent: Record<string, unknown>;
    };
    expect(out.structuredContent["id"]).toBe(1);
    expect(out.structuredContent["title"]).toBe("corrected");
    expect(out.structuredContent["truncated"]).toBe(false);
    expect(out.content[0]?.text).toContain("#1");
  });

  it("the returned task is the API's echo, not a synthesis of the request", async () => {
    // If the edit did not take, the agent must see that — never the value it
    // asked for reflected back at it.
    const wk = seedEcho(1, { title: "what Weeek actually stored" });
    const srv = register(wk);
    const out = (await srv.callHandler("weeek_update_task", MINIMAL)) as {
      structuredContent: Record<string, unknown>;
    };
    expect(out.structuredContent["title"]).toBe("what Weeek actually stored");
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
    const out = (await srv.callHandler("weeek_update_task", MINIMAL)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(out.isError).toBe(true);
    const text = out.content[0]?.text ?? "";
    expect(text).toMatch(/^weeek_update_task failed \(weeek_not_found\): /);
    expect(text).toContain(humanMessage(err));
  });

  it("error text never echoes body fragments; warn ctx is code+status only (INVARIANT-9)", async () => {
    const warnSpy = logger.warn as unknown as LoggerMethodSpy;
    const wk = makeMockWeeekClient();
    wk.rejectAll(
      new WeeekError({
        code: "weeek_forbidden",
        message: "leak: task title=top-secret-launch",
        status: 403,
      }),
    );
    const srv = register(wk);
    const out = (await srv.callHandler("weeek_update_task", MINIMAL)) as {
      content: Array<{ text: string }>;
    };
    expect(out.content[0]?.text ?? "").not.toContain("top-secret-launch");
    const ctx = warnSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(ctx).sort()).toEqual(["code", "status"]);
  });

  it("an unparseable 2xx echo warns that the EDIT landed and must not be re-issued", async () => {
    const wk = makeMockWeeekClient();
    wk.whenRequest("PUT", WEEEK_PATH.taskById(1), {
      status: 200,
      body: { success: true },
    });
    const srv = register(wk);
    const out = (await srv.callHandler("weeek_update_task", MINIMAL)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(out.isError).toBe(true);
    const text = out.content[0]?.text ?? "";
    expect(text).toMatch(
      /^weeek_update_task failed \(weeek_invalid_response\): /,
    );
    expect(text).toContain("the edit WAS applied");
    expect(text).toContain("weeek_get_task");
  });

  it("a rejected update carries NO landed-write note", async () => {
    const wk = makeMockWeeekClient();
    wk.whenRequest("PUT", WEEEK_PATH.taskById(1), {
      status: 422,
      body: { success: false },
    });
    const srv = register(wk);
    const out = (await srv.callHandler("weeek_update_task", MINIMAL)) as {
      content: Array<{ text: string }>;
    };
    expect(out.content[0]?.text ?? "").not.toContain("the edit WAS applied");
  });

  it("an empty update carries NO landed-write note either", async () => {
    // Both notes ride the same error leg; the empty-update refusal must not
    // pick up "the edit WAS applied" from the landed branch.
    const wk = seedEcho(1);
    const srv = register(wk);
    const out = (await srv.callHandler("weeek_update_task", {
      task_id: 1,
    })) as { content: Array<{ text: string }> };
    expect(out.content[0]?.text ?? "").not.toContain("the edit WAS applied");
  });

  it("non-WeeekError rejections propagate untouched (INVARIANT-6 boundary)", async () => {
    const wk = makeMockWeeekClient();
    wk.rejectAll(new Error("non-weeek failure"));
    const srv = register(wk);
    await expect(
      srv.callHandler("weeek_update_task", MINIMAL),
    ).rejects.toThrow(/non-weeek/);
  });

  it("the byte-budget gate is wired: a long description clips and sets truncated", async () => {
    const wk = seedEcho(1, { description: "x".repeat(50_000) });
    const srv = register(wk, makeEnvConfig({ maxResponseChars: 2048 }));
    const out = (await srv.callHandler("weeek_update_task", MINIMAL)) as {
      structuredContent: { description: string; truncated: boolean };
    };
    expect(out.structuredContent.truncated).toBe(true);
    expect(out.structuredContent.description.endsWith(MARKER)).toBe(true);
  });
});
