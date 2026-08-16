import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { registerWeeekCreateTaskTool } from "../../../src/tools/tasks/createTask.tool.js";
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
const MINIMAL = { title: "file this", project_id: 1 };

function seedEcho(
  id: number,
  overrides: Record<string, unknown> = {},
): ReturnType<typeof makeMockWeeekClient> {
  const wk = makeMockWeeekClient();
  wk.whenRequest("POST", WEEEK_PATH.tasksList, {
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
  registerWeeekCreateTaskTool(srv.server, { config, weeek: wk.client });
  return srv;
}

function inputShape(
  srv: ReturnType<typeof makeMockMcpServer>,
): Record<string, z.ZodTypeAny> {
  return srv.byName("weeek_create_task")?.config.inputSchema as Record<
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

describe("registerWeeekCreateTaskTool", () => {
  beforeEach(() => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "info").mockImplementation(() => {});
  });

  it("declares the write annotation profile (INVARIANT-12 marker + ADR 0004 §2)", () => {
    const srv = register(makeMockWeeekClient());
    expect(srv.byName("weeek_create_task")?.config.annotations).toMatchObject({
      readOnlyHint: false,
      // A spurious task in a live workspace is confirm-worthy.
      destructiveHint: true,
      // A re-fire is a second task — there is no target state to converge on.
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it("steers away from the edit and move tools (ADR 0004 §5)", () => {
    const srv = register(makeMockWeeekClient());
    const desc = srv.byName("weeek_create_task")?.config.description ?? "";
    expect(desc).toContain("DISTINCT from");
    expect(desc).toContain("weeek_update_task");
    expect(desc).toContain("weeek_move_task");
  });

  it("says a description and the assignee list are settable HERE and nowhere else (#63)", () => {
    // The limit lives on the tool that CAN do the thing as well as on the one
    // that cannot (`weeek_update_task` carries the other half). An agent asked
    // to reassign an existing task reads this side first about as often.
    const srv = register(makeMockWeeekClient());
    const desc = srv.byName("weeek_create_task")?.config.description ?? "";
    expect(desc).toMatch(/assignee list can ONLY be set here/);
  });

  it("input surface is the create — no task_id, no completion flag", () => {
    // `task_id` would mean "edit that one" (weeek_update_task) and a
    // completion flag would mean "close it" (weeek_complete_task); neither is
    // expressible here, which is a stronger signal than any description.
    const srv = register(makeMockWeeekClient());
    expect(Object.keys(inputShape(srv)).sort()).toEqual([
      "assignees",
      "board_column_id",
      "board_id",
      "description",
      "due_date",
      "priority",
      "project_id",
      "title",
      "type",
    ]);
  });

  it("title and project_id are required; every other input is optional", () => {
    const shape = inputShape(register(makeMockWeeekClient()));
    const required = Object.entries(shape)
      .filter(([, v]) => !v.isOptional())
      .map(([k]) => k)
      .sort();
    expect(required).toEqual(["project_id", "title"]);
  });

  it("an empty title is rejected by the schema, not sent as a blank card", () => {
    // The live API answers 200 to a create with no title at all and stores
    // `title: null` (probe #45). The schema is the ONLY guard against filing
    // an untitled card, so it has to reject the empty string too.
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

  it("a minimal call sends only the title and the target project", async () => {
    const wk = seedEcho(12);
    const srv = register(wk);
    await srv.callHandler("weeek_create_task", MINIMAL);
    const req = wk.requests()[0];
    expect(req?.method).toBe("POST");
    expect(req?.path).toBe(WEEEK_PATH.tasksList);
    // `toStrictEqual`: `toEqual` would ignore a stray `description: undefined`.
    expect(req && "body" in req ? req.body : undefined).toStrictEqual({
      title: "file this",
      projectId: 1,
    });
  });

  it("snake_case in, upstream camelCase out (INVARIANT-13 seam)", async () => {
    const wk = seedEcho(13);
    const srv = register(wk);
    await srv.callHandler("weeek_create_task", {
      ...MINIMAL,
      board_id: 1,
      board_column_id: 2,
      due_date: "2026-12-31",
      description: "why",
      type: "call",
      priority: 2,
      assignees: ["f47ac10b-58cc-4372-a567-deadbeef0003"],
    });
    expect(bodyOf(wk)).toStrictEqual({
      title: "file this",
      projectId: 1,
      description: "why",
      type: "call",
      priority: 2,
      boardId: 1,
      boardColumnId: 2,
      assignees: ["f47ac10b-58cc-4372-a567-deadbeef0003"],
      dueDate: "2026-12-31",
    });
  });

  it.each([
    ["description", { description: "d" }, "description"],
    ["type", { type: "meet" }, "type"],
    ["priority", { priority: 3 }, "priority"],
    ["board_id", { board_id: 4 }, "boardId"],
    ["board_column_id", { board_column_id: 5 }, "boardColumnId"],
    ["assignees", { assignees: ["u"] }, "assignees"],
    ["due_date", { due_date: "2026-01-01" }, "dueDate"],
  ])(
    "%s absent → the key is omitted entirely, never sent as null",
    async (_label, supplied, wireKey) => {
      const wk = seedEcho(14);
      const srv = register(wk);
      await srv.callHandler("weeek_create_task", MINIMAL);
      expect(Object.keys(bodyOf(wk))).not.toContain(wireKey);

      const wk2 = seedEcho(14);
      const srv2 = register(wk2);
      await srv2.callHandler("weeek_create_task", { ...MINIMAL, ...supplied });
      expect(Object.keys(bodyOf(wk2))).toContain(wireKey);
    },
  );

  it("priority 0 is Low, not unset — the falsy value reaches the wire", async () => {
    const wk = seedEcho(15);
    const srv = register(wk);
    await srv.callHandler("weeek_create_task", { ...MINIMAL, priority: 0 });
    expect(bodyOf(wk)["priority"]).toBe(0);
  });

  it("board and column are independent — either alone is expressible", async () => {
    // Unlike weeek_move_task, where a board without a column has no meaning:
    // on create the API resolves each alone (probe #45 — a column implies its
    // board, a board alone lands the task in that board's first column).
    const shape = inputShape(register(makeMockWeeekClient()));
    expect(shape["board_id"]?.isOptional()).toBe(true);
    expect(shape["board_column_id"]?.isOptional()).toBe(true);

    const wk = seedEcho(16);
    const srv = register(wk);
    await srv.callHandler("weeek_create_task", { ...MINIMAL, board_column_id: 3 });
    expect(bodyOf(wk)).toStrictEqual({
      title: "file this",
      projectId: 1,
      boardColumnId: 3,
    });
  });

  it("returns the task-detail output surface (same shape weeek_get_task returns)", () => {
    const srv = register(makeMockWeeekClient());
    const shape = srv.byName("weeek_create_task")?.config
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

  it("happy: structuredContent carries the NEW id + truncated:false", async () => {
    // The whole point of echoing the task: the agent gets the new id without a
    // follow-up read.
    const wk = seedEcho(12, { title: "file this" });
    const srv = register(wk);
    const out = (await srv.callHandler("weeek_create_task", MINIMAL)) as {
      content: Array<{ text: string }>;
      structuredContent: Record<string, unknown>;
    };
    expect(out.structuredContent["id"]).toBe(12);
    expect(out.structuredContent["title"]).toBe("file this");
    expect(out.structuredContent["truncated"]).toBe(false);
    expect(out.content[0]?.text).toContain("#12");
  });

  it("WeeekError → isError:true with the standard prefix + sentence (INVARIANT-7)", async () => {
    const wk = makeMockWeeekClient();
    const err = new WeeekError({
      code: "weeek_validation_error",
      message: "weeek http 422",
      status: 422,
    });
    wk.rejectAll(err);
    const srv = register(wk);
    const out = (await srv.callHandler("weeek_create_task", MINIMAL)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(out.isError).toBe(true);
    const text = out.content[0]?.text ?? "";
    expect(text).toMatch(
      /^weeek_create_task failed \(weeek_validation_error\): /,
    );
    expect(text).toContain(humanMessage(err));
  });

  it("error text never echoes body fragments; warn ctx is code+status only (INVARIANT-9)", async () => {
    const warnSpy = logger.warn as unknown as LoggerMethodSpy;
    const wk = makeMockWeeekClient();
    wk.rejectAll(
      new WeeekError({
        code: "weeek_not_found",
        message: "leak: project name=top-secret-launch",
        status: 404,
      }),
    );
    const srv = register(wk);
    const out = (await srv.callHandler("weeek_create_task", MINIMAL)) as {
      content: Array<{ text: string }>;
    };
    expect(out.content[0]?.text ?? "").not.toContain("top-secret-launch");
    const ctx = warnSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(ctx).sort()).toEqual(["code", "status"]);
  });

  it("an unparseable 2xx echo warns that the task EXISTS and must not be re-filed", async () => {
    const wk = makeMockWeeekClient();
    wk.whenRequest("POST", WEEEK_PATH.tasksList, {
      status: 200,
      body: { success: true },
    });
    const srv = register(wk);
    const out = (await srv.callHandler("weeek_create_task", MINIMAL)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(out.isError).toBe(true);
    const text = out.content[0]?.text ?? "";
    expect(text).toMatch(
      /^weeek_create_task failed \(weeek_invalid_response\): /,
    );
    expect(text).toContain("the task WAS created");
    expect(text).toContain("Do NOT re-issue");
    // The recovery route, since the id is exactly what was lost.
    expect(text).toContain("weeek_list_tasks");
  });

  it("a rejected create carries NO landed-write note", async () => {
    const wk = makeMockWeeekClient();
    wk.whenRequest("POST", WEEEK_PATH.tasksList, {
      status: 422,
      body: { success: false },
    });
    const srv = register(wk);
    const out = (await srv.callHandler("weeek_create_task", MINIMAL)) as {
      content: Array<{ text: string }>;
    };
    expect(out.content[0]?.text ?? "").not.toContain("the task WAS created");
  });

  it("non-WeeekError rejections propagate untouched (INVARIANT-6 boundary)", async () => {
    const wk = makeMockWeeekClient();
    wk.rejectAll(new Error("non-weeek failure"));
    const srv = register(wk);
    await expect(
      srv.callHandler("weeek_create_task", MINIMAL),
    ).rejects.toThrow(/non-weeek/);
  });

  it("the byte-budget gate is wired: a long description clips and sets truncated", async () => {
    const wk = seedEcho(1, { description: "x".repeat(50_000) });
    const srv = register(wk, makeEnvConfig({ maxResponseChars: 2048 }));
    const out = (await srv.callHandler("weeek_create_task", MINIMAL)) as {
      structuredContent: { description: string; truncated: boolean };
    };
    expect(out.structuredContent.truncated).toBe(true);
    expect(out.structuredContent.description.endsWith(MARKER)).toBe(true);
  });
});
