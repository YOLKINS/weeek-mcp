import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { registerWeeekCompleteTaskTool } from "../../../src/tools/tasks/completeTask.tool.js";
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

// Seeds both legs of the write: the `{success:true}` ack on the completion
// route, and the read-back the tool actually returns.
function seedTask(
  id: number,
  overrides: Record<string, unknown> = {},
): ReturnType<typeof makeMockWeeekClient> {
  const wk = makeMockWeeekClient();
  const ack = { status: 200, body: { success: true } };
  wk.whenRequest("POST", WEEEK_PATH.taskComplete(id), ack);
  wk.whenRequest("POST", WEEEK_PATH.taskUnComplete(id), ack);
  wk.whenRequest("GET", WEEEK_PATH.taskById(id), {
    status: 200,
    body: makeEnvelope("task", makeTaskDetailPayload({ id, ...overrides })),
  });
  return wk;
}

describe("registerWeeekCompleteTaskTool", () => {
  beforeEach(() => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "info").mockImplementation(() => {});
  });

  it("declares the write annotation profile (INVARIANT-12 marker + ADR 0004 §2)", () => {
    const srv = makeMockMcpServer();
    registerWeeekCompleteTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: makeMockWeeekClient().client,
    });
    const reg = srv.byName("weeek_complete_task");
    expect(reg).toBeDefined();
    expect(reg?.config.annotations).toMatchObject({
      // The load-bearing marker: what the READ_ONLY gate keys on and what
      // tells a client the call mutates.
      readOnlyHint: false,
      // A reversible status toggle, not a shape change.
      destructiveHint: false,
      // Explicit target state → a re-fire lands the same state.
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it("steers away from the two confusable mutations (ADR 0004 §5)", () => {
    const srv = makeMockMcpServer();
    registerWeeekCompleteTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: makeMockWeeekClient().client,
    });
    const desc = srv.byName("weeek_complete_task")?.config.description ?? "";
    expect(desc).toContain("DISTINCT from");
    expect(desc).toContain("weeek_update_task");
    expect(desc).toContain("weeek_move_task");
  });

  it("input surface is ONLY the toggle — no fields, no board, no column", () => {
    const srv = makeMockMcpServer();
    registerWeeekCompleteTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: makeMockWeeekClient().client,
    });
    const shape = srv.byName("weeek_complete_task")?.config
      .inputSchema as Record<string, unknown>;
    expect(Object.keys(shape).sort()).toEqual(["completed", "task_id"]);
    expect(shape["task_id"]).toBeInstanceOf(z.ZodNumber);
  });

  it("the toggle declares `true` as its schema default", () => {
    const srv = makeMockMcpServer();
    registerWeeekCompleteTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: makeMockWeeekClient().client,
    });
    const shape = srv.byName("weeek_complete_task")?.config
      .inputSchema as Record<string, z.ZodTypeAny>;
    const completed = shape["completed"] ?? z.never();
    expect(completed).toBeInstanceOf(z.ZodDefault);
    expect(z.object({ completed }).parse({})).toEqual({ completed: true });
  });

  it("returns the task-detail output surface (same shape weeek_get_task returns)", () => {
    const srv = makeMockMcpServer();
    registerWeeekCompleteTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: makeMockWeeekClient().client,
    });
    const shape = srv.byName("weeek_complete_task")?.config
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

  it("omitted toggle defaults to completing (handler-side, RETRO-21)", async () => {
    // The mock server deliberately bypasses zod, so this asserts the handler's
    // own defence-in-depth default rather than the SDK's schema substitution.
    const srv = makeMockMcpServer();
    const wk = seedTask(42, { isCompleted: true });
    registerWeeekCompleteTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    await srv.callHandler("weeek_complete_task", { task_id: 42 });
    expect(wk.requests()[0]?.path).toBe(WEEEK_PATH.taskComplete(42));
  });

  it("an explicit false is forwarded unchanged — it re-opens the task", async () => {
    const srv = makeMockMcpServer();
    const wk = seedTask(42, { isCompleted: false });
    registerWeeekCompleteTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_complete_task", {
      task_id: 42,
      completed: false,
    })) as { structuredContent: { completed: boolean } };
    expect(wk.requests()[0]?.path).toBe(WEEEK_PATH.taskUnComplete(42));
    expect(out.structuredContent.completed).toBe(false);
  });

  it("happy: structuredContent carries the read-back task + truncated:false", async () => {
    const srv = makeMockMcpServer();
    const wk = seedTask(42, { title: "answer", isCompleted: true });
    registerWeeekCompleteTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_complete_task", {
      task_id: 42,
      completed: true,
    })) as {
      content: Array<{ text: string }>;
      structuredContent: Record<string, unknown>;
    };
    expect(out.structuredContent["id"]).toBe(42);
    expect(out.structuredContent["title"]).toBe("answer");
    expect(out.structuredContent["completed"]).toBe(true);
    expect(out.structuredContent["truncated"]).toBe(false);
    expect(out.content[0]?.text).toContain("#42");
  });

  it("WeeekError → isError:true with the standard prefix + sentence (INVARIANT-7)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    const err = new WeeekError({
      code: "weeek_not_found",
      message: "weeek http 404",
      status: 404,
    });
    wk.rejectAll(err);
    registerWeeekCompleteTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_complete_task", {
      task_id: 99,
    })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(out.isError).toBe(true);
    const text = out.content[0]?.text ?? "";
    expect(text).toMatch(/^weeek_complete_task failed \(weeek_not_found\): /);
    expect(text).toContain(humanMessage(err));
  });

  it("error text never echoes body fragments; warn ctx is code+status only (INVARIANT-9)", async () => {
    const warnSpy = logger.warn as unknown as LoggerMethodSpy;
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.rejectAll(
      new WeeekError({
        code: "weeek_validation_error",
        message: "leak: task title=top-secret-launch",
        status: 422,
      }),
    );
    registerWeeekCompleteTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_complete_task", {
      task_id: 1,
    })) as { content: Array<{ text: string }> };
    expect(out.content[0]?.text ?? "").not.toContain("top-secret-launch");
    const ctx = warnSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(ctx).sort()).toEqual(["code", "status"]);
    expect(JSON.stringify(ctx)).not.toContain("top-secret-launch");
  });

  it("a failed read-back tells the agent the flag WAS written", async () => {
    // Two-leg write: without this the agent cannot tell a rejected write from
    // a landed one whose follow-up read failed, and would have to guess
    // whether re-issuing is a repeat or a repair.
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.whenRequest("POST", WEEEK_PATH.taskComplete(5), {
      status: 200,
      body: { success: true },
    });
    wk.whenRequest("GET", WEEEK_PATH.taskById(5), {
      status: 500,
      body: { success: false },
    });
    registerWeeekCompleteTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_complete_task", {
      task_id: 5,
    })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(out.isError).toBe(true);
    const text = out.content[0]?.text ?? "";
    // The standard prefix and sentence still lead (INVARIANT-7) …
    expect(text).toMatch(/^weeek_complete_task failed \(weeek_server_error\): /);
    // … and the leg-specific note follows.
    expect(text).toContain("The completion itself was applied");
  });

  it("a failure on the write leg carries NO read-back note", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.whenRequest("POST", WEEEK_PATH.taskComplete(5), {
      status: 403,
      body: { success: false },
    });
    registerWeeekCompleteTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_complete_task", {
      task_id: 5,
    })) as { content: Array<{ text: string }> };
    expect(out.content[0]?.text ?? "").not.toContain(
      "The completion itself was applied",
    );
  });

  it("non-WeeekError rejections propagate untouched (INVARIANT-6 boundary)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.rejectAll(new Error("non-weeek failure"));
    registerWeeekCompleteTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    await expect(
      srv.callHandler("weeek_complete_task", { task_id: 1 }),
    ).rejects.toThrow(/non-weeek/);
  });

  it("the byte-budget gate is wired: a long description clips and sets truncated", async () => {
    const srv = makeMockMcpServer();
    const wk = seedTask(1, { description: "x".repeat(50_000) });
    registerWeeekCompleteTaskTool(srv.server, {
      config: makeEnvConfig({ maxResponseChars: 2048 }),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_complete_task", {
      task_id: 1,
    })) as { structuredContent: { description: string; truncated: boolean } };
    expect(out.structuredContent.truncated).toBe(true);
    expect(out.structuredContent.description.endsWith(MARKER)).toBe(true);
  });
});
