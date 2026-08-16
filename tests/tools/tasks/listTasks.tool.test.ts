import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { registerWeeekListTasksTool } from "../../../src/tools/tasks/listTasks.tool.js";
import { WeeekError } from "../../../src/weeek/types.js";
import { humanMessage } from "../../../src/weeek/humanMessage.js";
import { logger } from "../../../src/logging/logger.js";
import {
  makeEnvConfig,
  makeEnvelope,
  makeTaskSummaryPayload,
} from "../../helpers/factories.js";
import { makeMockMcpServer } from "../../helpers/mockMcpServer.js";
import { makeMockWeeekClient } from "../../helpers/mockWeeekClient.js";
import { WEEEK_PATH } from "../../helpers/paths.js";

describe("registerWeeekListTasksTool", () => {
  beforeEach(() => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "info").mockImplementation(() => {});
  });

  it("registers with annotations + outputSchema (tasks, hasMore, truncated)", () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    registerWeeekListTasksTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const reg = srv.byName("weeek_list_tasks");
    expect(reg).toBeDefined();
    expect(reg?.config.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    const outputShape = reg?.config.outputSchema as Record<string, unknown>;
    expect(outputShape["tasks"]).toBeDefined();
    expect(outputShape["hasMore"]).toBeDefined();
    expect(outputShape["truncated"]).toBeDefined();
  });

  it("outputSchema tasks element exposes userId + assignees (I7 BREAK)", () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    registerWeeekListTasksTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const reg = srv.byName("weeek_list_tasks");
    const outputShape = reg?.config.outputSchema as Record<
      string,
      z.ZodTypeAny
    >;
    const taskShape = (outputShape["tasks"] as z.ZodArray<z.ZodTypeAny>)
      ._def.type as z.ZodObject<z.ZodRawShape>;
    const innerKeys = Object.keys(taskShape.shape);
    expect(innerKeys).toContain("userId");
    expect(innerKeys).toContain("assignees");
  });

  it("structuredContent.tasks[].userId / .assignees carry through from the parser", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    // D3 perPage.default(20) rewrites the default-args path to
    // `?perPage=20`; the exact-match mock must key on that, not the bare path.
    wk.whenRequest("GET", `${WEEEK_PATH.tasksList}?perPage=20`, {
      status: 200,
      body: {
        ...makeEnvelope("tasks", [
          makeTaskSummaryPayload({
            id: 1,
            userId: "f47ac10b-58cc-4372-a567-deadbeef0001",
            assignees: ["f47ac10b-58cc-4372-a567-deadbeef0001"],
          }),
        ]),
        hasMore: false,
      },
    });
    registerWeeekListTasksTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_tasks", {})) as {
      structuredContent: {
        tasks: Array<{ userId: string | null; assignees: string[] }>;
      };
    };
    expect(out.structuredContent.tasks[0]?.userId).toBe(
      "f47ac10b-58cc-4372-a567-deadbeef0001",
    );
    expect(out.structuredContent.tasks[0]?.assignees).toEqual([
      "f47ac10b-58cc-4372-a567-deadbeef0001",
    ]);
  });

  it("structuredContent.tasks[].priority null surfaces at the tool boundary (bug #25)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.whenRequest("GET", `${WEEEK_PATH.tasksList}?perPage=20`, {
      status: 200,
      body: {
        ...makeEnvelope("tasks", [
          makeTaskSummaryPayload({ id: 1, priority: null }),
        ]),
        hasMore: false,
      },
    });
    registerWeeekListTasksTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_tasks", {})) as {
      structuredContent: { tasks: Array<{ priority: number | null }> };
    };
    expect(out.structuredContent.tasks[0]?.priority).toBeNull();
  });

  it("inputSchema has per_page zod with min 1 / max 100 (and default 20)", () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    registerWeeekListTasksTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const reg = srv.byName("weeek_list_tasks");
    const inputShape = reg?.config.inputSchema as Record<string, unknown>;
    // per_page is z.number().int().min(1).max(100).default(20) — D3 in
    // I7-prep gave it a default so an LLM that omits the field still gets a
    // sane 20-item page (sized to fit the typical 25k MCP-token cap).
    // project_id remains z.ZodOptional (no default — undefined means "no
    // filter"). Both are snake_case since D4 (#41).
    expect(inputShape["per_page"]).toBeInstanceOf(z.ZodDefault);
    expect(inputShape["project_id"]).toBeInstanceOf(z.ZodOptional);
  });

  it("happy with no args: endpoint hit with perPage=20 default (D3)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.whenRequest("GET", `${WEEEK_PATH.tasksList}?perPage=20`, {
      status: 200,
      body: makeEnvelope("tasks", []),
    });
    registerWeeekListTasksTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    await srv.callHandler("weeek_list_tasks", {});
    expect(wk.requests()[0]?.path).toBe(`${WEEEK_PATH.tasksList}?perPage=20`);
  });

  it("per_page explicit value wins over the default", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.setDefault({ status: 200, body: makeEnvelope("tasks", []) });
    registerWeeekListTasksTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    await srv.callHandler("weeek_list_tasks", { per_page: 100 });
    expect(wk.requests()[0]?.path).toBe(`${WEEEK_PATH.tasksList}?perPage=100`);
  });

  it("per_page 0 — schema rejects (min 1)", () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    registerWeeekListTasksTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const reg = srv.byName("weeek_list_tasks");
    const inputShape = reg?.config.inputSchema as Record<string, unknown>;
    const perPage = inputShape["per_page"] as z.ZodTypeAny;
    expect(z.object({ perPage }).safeParse({ perPage: 0 }).success).toBe(false);
  });

  it("per_page 101 — schema rejects (max 100)", () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    registerWeeekListTasksTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const reg = srv.byName("weeek_list_tasks");
    const inputShape = reg?.config.inputSchema as Record<string, unknown>;
    const perPage = inputShape["per_page"] as z.ZodTypeAny;
    expect(z.object({ perPage }).safeParse({ perPage: 101 }).success).toBe(
      false,
    );
  });

  it("forwards filter args to the endpoint querystring", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.setDefault({
      status: 200,
      body: makeEnvelope("tasks", []),
    });
    registerWeeekListTasksTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    // The seam where the two conventions meet (D4, #41): the tool input is
    // snake_case, the upstream Weeek query string stays camelCase. Both
    // halves are asserted here so a "helpful" future rename of the query
    // parameters — which would silently drop every filter upstream — fails.
    await srv.callHandler("weeek_list_tasks", {
      project_id: 5,
      completed: true,
      offset: 0,
      per_page: 10,
    });
    expect(wk.requests()[0]?.path).toBe(
      `${WEEEK_PATH.tasksList}?projectId=5&completed=1&offset=0&perPage=10`,
    );
  });

  // #48 — board / board-column filters. The input names are snake_case
  // (INVARIANT-13), the query parameters stay upstream camelCase; this is the
  // same seam the project/completion filters cross above.
  it("board_id / board_column_id map onto the camelCase query parameters", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.setDefault({ status: 200, body: makeEnvelope("tasks", []) });
    registerWeeekListTasksTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    await srv.callHandler("weeek_list_tasks", {
      board_id: 7,
      board_column_id: 3,
      per_page: 20,
    });
    expect(wk.requests()[0]?.path).toBe(
      `${WEEEK_PATH.tasksList}?boardId=7&boardColumnId=3&perPage=20`,
    );
  });

  it("the new filters compose with project_id and completed", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.setDefault({ status: 200, body: makeEnvelope("tasks", []) });
    registerWeeekListTasksTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    await srv.callHandler("weeek_list_tasks", {
      project_id: 1,
      board_id: 7,
      board_column_id: 3,
      completed: false,
      per_page: 20,
    });
    expect(wk.requests()[0]?.path).toBe(
      `${WEEEK_PATH.tasksList}?projectId=1&boardId=7&boardColumnId=3&completed=0&perPage=20`,
    );
  });

  it("omitted board filters add nothing to the query string", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.setDefault({ status: 200, body: makeEnvelope("tasks", []) });
    registerWeeekListTasksTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    await srv.callHandler("weeek_list_tasks", { project_id: 1 });
    expect(wk.requests()[0]?.path).toBe(
      `${WEEEK_PATH.tasksList}?projectId=1&perPage=20`,
    );
  });

  // #51 — the assignee filter. The input is named for what the caller means
  // ("tasks assigned to this person"); the upstream parameter is `userId`.
  // The rename is the whole risk here: a future "consistency" pass that
  // serialized it as `?assigneeId=` would be silently ignored by Weeek —
  // an unknown query parameter is not an error, it is a no-op filter — and
  // the agent would act on an unfiltered queue believing it was narrowed.
  it("assignee_id maps onto the upstream userId query parameter", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.setDefault({ status: 200, body: makeEnvelope("tasks", []) });
    registerWeeekListTasksTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    await srv.callHandler("weeek_list_tasks", {
      assignee_id: "f47ac10b-58cc-4372-a567-deadbeef0004",
      per_page: 20,
    });
    expect(wk.requests()[0]?.path).toBe(
      `${WEEEK_PATH.tasksList}?userId=f47ac10b-58cc-4372-a567-deadbeef0004&perPage=20`,
    );
  });

  it("assignee_id composes with the project, board, column and completion filters", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.setDefault({ status: 200, body: makeEnvelope("tasks", []) });
    registerWeeekListTasksTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    await srv.callHandler("weeek_list_tasks", {
      project_id: 1,
      board_id: 4,
      board_column_id: 11,
      assignee_id: "f47ac10b-58cc-4372-a567-deadbeef0004",
      completed: false,
      per_page: 20,
    });
    expect(wk.requests()[0]?.path).toBe(
      `${WEEEK_PATH.tasksList}?projectId=1&boardId=4&boardColumnId=11` +
        `&userId=f47ac10b-58cc-4372-a567-deadbeef0004&completed=0&perPage=20`,
    );
  });

  it("an omitted assignee_id adds no query parameter at all", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.setDefault({ status: 200, body: makeEnvelope("tasks", []) });
    registerWeeekListTasksTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    await srv.callHandler("weeek_list_tasks", { board_id: 4 });
    expect(wk.requests()[0]?.path).toBe(
      `${WEEEK_PATH.tasksList}?boardId=4&perPage=20`,
    );
  });

  it("assignee_id is an optional uuid", () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    registerWeeekListTasksTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const inputShape = srv.byName("weeek_list_tasks")?.config
      .inputSchema as Record<string, z.ZodTypeAny>;
    const field = inputShape["assignee_id"] as z.ZodTypeAny;
    expect(field).toBeInstanceOf(z.ZodOptional);
    const wrapped = z.object({ field });
    expect(wrapped.safeParse({}).success).toBe(true);
    expect(
      wrapped.safeParse({ field: "f47ac10b-58cc-4372-a567-deadbeef0004" })
        .success,
    ).toBe(true);
    // A member id is a UUID (probe 2026-05-13); anything else is a client-side
    // reject rather than a 422 round-trip.
    expect(wrapped.safeParse({ field: "not-a-uuid@example.com" }).success).toBe(
      false,
    );
    expect(wrapped.safeParse({ field: "" }).success).toBe(false);
    expect(wrapped.safeParse({ field: 42 }).success).toBe(false);
  });

  // The probe (2026-07-23, #51) settled the semantics the description states:
  // `?userId=` matches **any** assignee, not only the primary one. An agent
  // reading "primary only" would silently work the wrong queue, so the claim
  // is pinned here — if a future probe overturns it, this test is the thing
  // that has to be edited deliberately.
  it("the assignee_id description states the any-assignee semantics and the 422 failure mode", () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    registerWeeekListTasksTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const inputShape = srv.byName("weeek_list_tasks")?.config
      .inputSchema as Record<string, z.ZodTypeAny>;
    const description = (
      inputShape["assignee_id"] as z.ZodTypeAny
    ).description?.toLowerCase();
    expect(description).toContain("any assignee");
    expect(description).toContain("not only the primary");
    expect(description).toContain("weeek_list_members");
    expect(description).toContain("422");
  });

  it("board_id / board_column_id are optional positive ints", () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    registerWeeekListTasksTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const inputShape = srv.byName("weeek_list_tasks")?.config
      .inputSchema as Record<string, z.ZodTypeAny>;
    for (const key of ["board_id", "board_column_id"]) {
      const field = inputShape[key] as z.ZodTypeAny;
      expect(field).toBeInstanceOf(z.ZodOptional);
      const wrapped = z.object({ field });
      expect(wrapped.safeParse({}).success).toBe(true);
      expect(wrapped.safeParse({ field: 1 }).success).toBe(true);
      expect(wrapped.safeParse({ field: 0 }).success).toBe(false);
      expect(wrapped.safeParse({ field: 1.5 }).success).toBe(false);
    }
  });

  // The bounded set is the point of #48: a write workflow needs to find the
  // card it is about to act on, and nothing more. A date / tag / search /
  // sort / show-everything filter arriving later is a scope decision, not a
  // drive-by addition.
  it("no date, tag, search, sort or show-everything filter is exposed", () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    registerWeeekListTasksTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const inputShape = srv.byName("weeek_list_tasks")?.config
      .inputSchema as Record<string, unknown>;
    // `user_id` joins the list with #51: the assignee filter ships as
    // `assignee_id`, so a second input spelled the upstream way would be a
    // duplicate of it under the name an agent is most likely to reach for.
    for (const banned of [
      "day",
      "due_date",
      "tags",
      "search",
      "sort_by",
      "all",
      "type",
      "priority",
      "user_id",
    ]) {
      expect(inputShape[banned]).toBeUndefined();
    }
  });

  it("text format: '<n> task(s), hasMore=<b>'", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    // setDefault rather than whenRequest: the D3 perPage default rewrites
    // the path with `?perPage=20`, which would not match a bare-path
    // whenRequest entry.
    wk.setDefault({
      status: 200,
      body: {
        ...makeEnvelope("tasks", [
          makeTaskSummaryPayload({ id: 1 }),
          makeTaskSummaryPayload({ id: 2 }),
        ]),
        hasMore: true,
      },
    });
    registerWeeekListTasksTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_tasks", {})) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(out.content[0]?.text).toBe("2 task(s), hasMore=true");
  });

  it("WeeekError → isError:true with prefix + humanMessage (INVARIANT-7)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    const err = new WeeekError({
      code: "weeek_rate_limited",
      message: "weeek http 429",
      status: 429,
    });
    wk.rejectAll(err);
    registerWeeekListTasksTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_tasks", {})) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(out.isError).toBe(true);
    const text = out.content[0]?.text ?? "";
    expect(text).toMatch(/^weeek_list_tasks failed \(weeek_rate_limited\): /);
    expect(text).toContain(humanMessage(err));
  });

  it("WeeekError text never echoes err.message body fragments (INVARIANT-2)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.rejectAll(
      new WeeekError({
        code: "weeek_rate_limited",
        message: "leak: tasks=top-secret-launch",
        status: 429,
      }),
    );
    registerWeeekListTasksTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_tasks", {})) as {
      content: Array<{ type: string; text: string }>;
    };
    const text = out.content[0]?.text ?? "";
    expect(text).not.toContain("top-secret-launch");
    expect(text).toMatch(/^weeek_list_tasks failed \(weeek_[a-z_]+\): /);
  });

  it("non-WeeekError rejections propagate untouched", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.rejectAll(new Error("non-weeek failure"));
    registerWeeekListTasksTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    await expect(srv.callHandler("weeek_list_tasks", {})).rejects.toThrow(
      /non-weeek/,
    );
  });

  it("truncation preserves hasMore (truncated and hasMore are independent)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    const many = Array.from({ length: 100 }, (_, i) =>
      makeTaskSummaryPayload({
        id: i + 1,
        title: "T".repeat(60),
      }),
    );
    wk.setDefault({
      status: 200,
      body: { ...makeEnvelope("tasks", many), hasMore: true },
    });
    registerWeeekListTasksTool(srv.server, {
      config: makeEnvConfig({ maxResponseChars: 2048 }),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_tasks", {})) as {
      structuredContent: {
        tasks: unknown[];
        hasMore: boolean;
        truncated: boolean;
      };
    };
    expect(out.structuredContent.truncated).toBe(true);
    expect(out.structuredContent.hasMore).toBe(true);
    expect(out.structuredContent.tasks.length).toBeLessThan(100);
  });
});
