import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { registerWeeekMoveTaskTool } from "../../../src/tools/tasks/moveTask.tool.js";
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

describe("registerWeeekMoveTaskTool", () => {
  beforeEach(() => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "info").mockImplementation(() => {});
  });

  it("declares the write annotation profile (INVARIANT-12 marker + ADR 0004 §2)", () => {
    const srv = makeMockMcpServer();
    registerWeeekMoveTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: makeMockWeeekClient().client,
    });
    expect(srv.byName("weeek_move_task")?.config.annotations).toMatchObject({
      readOnlyHint: false,
      // Re-parenting the wrong card is worth a human confirm.
      destructiveHint: true,
      // A second move is a second mutation — there is no target state to
      // converge on the way the completion toggle has.
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it("steers away from field edits and the completion toggle (ADR 0004 §5)", () => {
    const srv = makeMockMcpServer();
    registerWeeekMoveTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: makeMockWeeekClient().client,
    });
    const desc = srv.byName("weeek_move_task")?.config.description ?? "";
    expect(desc).toContain("DISTINCT from");
    expect(desc).toContain("weeek_update_task");
    expect(desc).toContain("weeek_complete_task");
    // The load-bearing fact an agent needs: a column is a status.
    expect(desc).toMatch(/column IS a status|column is a status/i);
  });

  it("input surface is ONLY the move — no fields, no completion flag", () => {
    const srv = makeMockMcpServer();
    registerWeeekMoveTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: makeMockWeeekClient().client,
    });
    const shape = srv.byName("weeek_move_task")?.config.inputSchema as Record<
      string,
      unknown
    >;
    expect(Object.keys(shape).sort()).toEqual([
      "board_column_id",
      "board_id",
      "task_id",
    ]);
  });

  it("a board without a column is not expressible: the column is required", () => {
    // The schema is the guard, not the description: `board_id` is optional and
    // `board_column_id` is not, so "move to that board, you pick the column"
    // cannot be sent at all.
    const srv = makeMockMcpServer();
    registerWeeekMoveTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: makeMockWeeekClient().client,
    });
    const shape = srv.byName("weeek_move_task")?.config.inputSchema as Record<
      string,
      z.ZodTypeAny
    >;
    const column = shape["board_column_id"] ?? z.never();
    const board = shape["board_id"] ?? z.never();
    expect(column.isOptional()).toBe(false);
    expect(board.isOptional()).toBe(true);
    expect(() => z.object({ board_column_id: column }).parse({})).toThrow();
  });

  it("column only → a same-board move; the board is not sent", async () => {
    const srv = makeMockMcpServer();
    const wk = seedEcho(42);
    registerWeeekMoveTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    await srv.callHandler("weeek_move_task", {
      task_id: 42,
      board_column_id: 7,
    });
    const req = wk.requests()[0];
    expect(req?.method).toBe("PUT");
    // `toStrictEqual`: `toEqual` would ignore a stray `boardId: undefined`.
    expect(req && "body" in req ? req.body : undefined).toStrictEqual({
      boardColumnId: 7,
    });
  });

  it("board + column → the cross-board re-parent", async () => {
    const srv = makeMockMcpServer();
    const wk = seedEcho(42);
    registerWeeekMoveTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    await srv.callHandler("weeek_move_task", {
      task_id: 42,
      board_column_id: 9,
      board_id: 3,
    });
    const req = wk.requests()[0];
    expect(req && "body" in req ? req.body : undefined).toStrictEqual({
      boardId: 3,
      boardColumnId: 9,
    });
  });

  it("returns the task-detail output surface (same shape weeek_get_task returns)", () => {
    const srv = makeMockMcpServer();
    registerWeeekMoveTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: makeMockWeeekClient().client,
    });
    const shape = srv.byName("weeek_move_task")?.config.outputSchema as Record<
      string,
      unknown
    >;
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

  it("happy: structuredContent carries the echoed task + truncated:false", async () => {
    const srv = makeMockMcpServer();
    const wk = seedEcho(42, { title: "moved" });
    registerWeeekMoveTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_move_task", {
      task_id: 42,
      board_column_id: 7,
    })) as {
      content: Array<{ text: string }>;
      structuredContent: Record<string, unknown>;
    };
    expect(out.structuredContent["id"]).toBe(42);
    expect(out.structuredContent["title"]).toBe("moved");
    expect(out.structuredContent["truncated"]).toBe(false);
    expect(out.content[0]?.text).toContain("#42");
  });

  it("WeeekError → isError:true with the standard prefix + sentence (INVARIANT-7)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    const err = new WeeekError({
      code: "weeek_validation_error",
      message: "weeek http 422",
      status: 422,
    });
    wk.rejectAll(err);
    registerWeeekMoveTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_move_task", {
      task_id: 1,
      board_column_id: 7,
    })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(out.isError).toBe(true);
    const text = out.content[0]?.text ?? "";
    expect(text).toMatch(
      /^weeek_move_task failed \(weeek_validation_error\): /,
    );
    expect(text).toContain(humanMessage(err));
  });

  it("error text never echoes body fragments; warn ctx is code+status only (INVARIANT-9)", async () => {
    const warnSpy = logger.warn as unknown as LoggerMethodSpy;
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.rejectAll(
      new WeeekError({
        code: "weeek_not_found",
        message: "leak: board name=top-secret-launch",
        status: 404,
      }),
    );
    registerWeeekMoveTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_move_task", {
      task_id: 1,
      board_column_id: 7,
    })) as { content: Array<{ text: string }> };
    expect(out.content[0]?.text ?? "").not.toContain("top-secret-launch");
    const ctx = warnSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(ctx).sort()).toEqual(["code", "status"]);
  });

  it("an unparseable 2xx echo warns the agent NOT to retry the landed move", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.whenRequest("PUT", WEEEK_PATH.taskById(1), {
      status: 200,
      body: { success: true },
    });
    registerWeeekMoveTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_move_task", {
      task_id: 1,
      board_column_id: 7,
    })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(out.isError).toBe(true);
    const text = out.content[0]?.text ?? "";
    expect(text).toMatch(/^weeek_move_task failed \(weeek_invalid_response\): /);
    expect(text).toContain("the move itself was applied");
    expect(text).toContain("Do NOT re-issue");
  });

  it("a rejected move carries NO landed-write note", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.whenRequest("PUT", WEEEK_PATH.taskById(1), {
      status: 422,
      body: { success: false },
    });
    registerWeeekMoveTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_move_task", {
      task_id: 1,
      board_column_id: 7,
    })) as { content: Array<{ text: string }> };
    expect(out.content[0]?.text ?? "").not.toContain(
      "the move itself was applied",
    );
  });

  it("non-WeeekError rejections propagate untouched (INVARIANT-6 boundary)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.rejectAll(new Error("non-weeek failure"));
    registerWeeekMoveTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    await expect(
      srv.callHandler("weeek_move_task", { task_id: 1, board_column_id: 7 }),
    ).rejects.toThrow(/non-weeek/);
  });

  it("the byte-budget gate is wired: a long description clips and sets truncated", async () => {
    const srv = makeMockMcpServer();
    const wk = seedEcho(1, { description: "x".repeat(50_000) });
    registerWeeekMoveTaskTool(srv.server, {
      config: makeEnvConfig({ maxResponseChars: 2048 }),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_move_task", {
      task_id: 1,
      board_column_id: 7,
    })) as { structuredContent: { description: string; truncated: boolean } };
    expect(out.structuredContent.truncated).toBe(true);
    expect(out.structuredContent.description.endsWith(MARKER)).toBe(true);
  });
});
