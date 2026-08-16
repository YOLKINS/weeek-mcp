import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { registerWeeekGetTaskTool } from "../../../src/tools/tasks/getTask.tool.js";
import { WeeekError } from "../../../src/weeek/types.js";
import { humanMessage } from "../../../src/weeek/humanMessage.js";
import { logger } from "../../../src/logging/logger.js";
import {
  makeEnvConfig,
  makeEnvelope,
  makeTaskDetailPayload,
} from "../../helpers/factories.js";
import { makeMockMcpServer } from "../../helpers/mockMcpServer.js";
import { makeMockWeeekClient } from "../../helpers/mockWeeekClient.js";
import { WEEEK_PATH } from "../../helpers/paths.js";

const MARKER = "…[truncated]";

describe("registerWeeekGetTaskTool", () => {
  beforeEach(() => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "info").mockImplementation(() => {});
  });

  it("registers with annotations + outputSchema (description nullable + truncated + userId + assignees)", () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    registerWeeekGetTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const reg = srv.byName("weeek_get_task");
    expect(reg).toBeDefined();
    expect(reg?.config.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    const outputShape = reg?.config.outputSchema as Record<string, unknown>;
    expect(outputShape["description"]).toBeDefined();
    expect(outputShape["truncated"]).toBeDefined();
    // I7 BREAK: required multi-assignee fields on TaskDetail.
    expect(outputShape["userId"]).toBeDefined();
    expect(outputShape["assignees"]).toBeDefined();
  });

  it("structuredContent carries userId + assignees from the parser (I7 BREAK)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.whenRequest("GET", WEEEK_PATH.taskById(42), {
      status: 200,
      body: makeEnvelope(
        "task",
        makeTaskDetailPayload({
          id: 42,
          userId: "f47ac10b-58cc-4372-a567-deadbeef0001",
          assignees: [
            "f47ac10b-58cc-4372-a567-deadbeef0001",
            "b2c9f357-c0e6-5e54-ba37-cafebabe0002",
          ],
        }),
      ),
    });
    registerWeeekGetTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_get_task", { task_id: 42 })) as {
      structuredContent: {
        userId: string | null;
        assignees: string[];
      };
    };
    expect(out.structuredContent.userId).toBe(
      "f47ac10b-58cc-4372-a567-deadbeef0001",
    );
    expect(out.structuredContent.assignees).toEqual([
      "f47ac10b-58cc-4372-a567-deadbeef0001",
      "b2c9f357-c0e6-5e54-ba37-cafebabe0002",
    ]);
  });

  it("inputSchema requires `task_id` (zod number)", () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    registerWeeekGetTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const inputShape = srv.byName("weeek_get_task")?.config.inputSchema as Record<
      string,
      unknown
    >;
    expect(inputShape["task_id"]).toBeInstanceOf(z.ZodNumber);
  });

  it("happy: hits /tm/tasks/{id}, text '#<id> <title>'", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.whenRequest("GET", WEEEK_PATH.taskById(42), {
      status: 200,
      body: makeEnvelope(
        "task",
        makeTaskDetailPayload({ id: 42, title: "answer" }),
      ),
    });
    registerWeeekGetTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_get_task", { task_id: 42 })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(out.content[0]?.text).toBe("#42 answer");
    expect(wk.requests()[0]?.path).toBe(WEEEK_PATH.taskById(42));
  });

  it("description: null passes through with truncated:false", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.whenRequest("GET", WEEEK_PATH.taskById(1), {
      status: 200,
      body: makeEnvelope(
        "task",
        makeTaskDetailPayload({ id: 1, description: null }),
      ),
    });
    registerWeeekGetTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_get_task", { task_id: 1 })) as {
      structuredContent: { description: string | null; truncated: boolean };
    };
    expect(out.structuredContent.description).toBeNull();
    expect(out.structuredContent.truncated).toBe(false);
  });

  it("structuredContent.priority null surfaces at the tool boundary (bug #25)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.whenRequest("GET", WEEEK_PATH.taskById(1), {
      status: 200,
      body: makeEnvelope(
        "task",
        makeTaskDetailPayload({ id: 1, priority: null }),
      ),
    });
    registerWeeekGetTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_get_task", { task_id: 1 })) as {
      structuredContent: { priority: number | null };
    };
    expect(out.structuredContent.priority).toBeNull();
  });

  it("WeeekError(weeek_not_found) → isError:true with prefix + humanMessage (INVARIANT-7)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    const err = new WeeekError({
      code: "weeek_not_found",
      message: "weeek http 404",
      status: 404,
    });
    wk.rejectAll(err);
    registerWeeekGetTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_get_task", { task_id: 99 })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(out.isError).toBe(true);
    const text = out.content[0]?.text ?? "";
    expect(text).toMatch(/^weeek_get_task failed \(weeek_not_found\): /);
    expect(text).toContain(humanMessage(err));
  });

  it("WeeekError text never echoes err.message body fragments (INVARIANT-2)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.rejectAll(
      new WeeekError({
        code: "weeek_not_found",
        message: "leak: task title=top-secret-launch",
        status: 404,
      }),
    );
    registerWeeekGetTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_get_task", { task_id: 1 })) as {
      content: Array<{ type: string; text: string }>;
    };
    const text = out.content[0]?.text ?? "";
    expect(text).not.toContain("top-secret-launch");
    expect(text).toMatch(/^weeek_get_task failed \(weeek_[a-z_]+\): /);
  });

  it("non-WeeekError rejections propagate untouched", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.rejectAll(new Error("non-weeek failure"));
    registerWeeekGetTaskTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    await expect(srv.callHandler("weeek_get_task", { task_id: 1 })).rejects.toThrow(
      /non-weeek/,
    );
  });

  it("long description on a tight budget: description ends with the truncation marker", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.whenRequest("GET", WEEEK_PATH.taskById(1), {
      status: 200,
      body: makeEnvelope(
        "task",
        makeTaskDetailPayload({ id: 1, description: "x".repeat(50_000) }),
      ),
    });
    registerWeeekGetTaskTool(srv.server, {
      config: makeEnvConfig({ maxResponseChars: 2048 }),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_get_task", { task_id: 1 })) as {
      structuredContent: { description: string; truncated: boolean };
    };
    expect(out.structuredContent.truncated).toBe(true);
    expect(out.structuredContent.description.endsWith(MARKER)).toBe(true);
  });
});
