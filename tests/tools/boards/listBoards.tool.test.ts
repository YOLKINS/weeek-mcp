import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { registerWeeekListBoardsTool } from "../../../src/tools/boards/listBoards.tool.js";
import { WeeekError } from "../../../src/weeek/types.js";
import { humanMessage } from "../../../src/weeek/humanMessage.js";
import { logger } from "../../../src/logging/logger.js";
import {
  makeEnvConfig,
  makeEnvelope,
  makeBoardPayload,
} from "../../helpers/factories.js";
import { makeMockMcpServer } from "../../helpers/mockMcpServer.js";
import { makeMockWeeekClient } from "../../helpers/mockWeeekClient.js";
import { WEEEK_PATH } from "../../helpers/paths.js";

describe("registerWeeekListBoardsTool", () => {
  beforeEach(() => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "info").mockImplementation(() => {});
  });

  it("registers with annotations + outputSchema {boards, truncated}", () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    registerWeeekListBoardsTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const reg = srv.byName("weeek_list_boards");
    expect(reg).toBeDefined();
    expect(reg?.config.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    const outputShape = reg?.config.outputSchema as Record<string, unknown>;
    expect(outputShape["boards"]).toBeDefined();
    expect(outputShape["truncated"]).toBeDefined();
  });

  it("inputSchema requires project_id (z.ZodNumber, not optional)", () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    registerWeeekListBoardsTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const inputShape = srv.byName("weeek_list_boards")?.config
      .inputSchema as Record<string, unknown>;
    expect(inputShape["project_id"]).toBeInstanceOf(z.ZodNumber);
  });

  it("happy: text '<n> board(s)' + structuredContent + truncated:false; path carries projectId", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.whenRequest("GET", `${WEEEK_PATH.boardsList}?projectId=5`, {
      status: 200,
      body: makeEnvelope("boards", [
        makeBoardPayload({ id: 1, name: "Backlog", projectId: 5 }),
        makeBoardPayload({ id: 2, name: "Sprint", projectId: 5 }),
      ]),
    });
    registerWeeekListBoardsTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_boards", {
      project_id: 5,
    })) as {
      content: Array<{ type: string; text: string }>;
      structuredContent: { boards: unknown[]; truncated: boolean };
    };
    expect(out.content[0]?.text).toBe("2 board(s)");
    expect(out.structuredContent.truncated).toBe(false);
    expect(out.structuredContent.boards).toHaveLength(2);
    expect(wk.requests()[0]?.path).toBe(
      `${WEEEK_PATH.boardsList}?projectId=5`,
    );
  });

  it("WeeekError → isError:true with prefix + humanMessage (INVARIANT-7)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    const err = new WeeekError({
      code: "weeek_unauthorized",
      message: "weeek http 401",
      status: 401,
    });
    wk.rejectAll(err);
    registerWeeekListBoardsTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_boards", {
      project_id: 5,
    })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(out.isError).toBe(true);
    const text = out.content[0]?.text ?? "";
    expect(text).toMatch(/^weeek_list_boards failed \(weeek_unauthorized\): /);
    expect(text).toContain(humanMessage(err));
  });

  it("WeeekError text never echoes err.message body fragments (INVARIANT-2)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.rejectAll(
      new WeeekError({
        code: "weeek_server_error",
        message: "leak: board=top-secret-launch",
        status: 500,
      }),
    );
    registerWeeekListBoardsTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_boards", {
      project_id: 1,
    })) as {
      content: Array<{ type: string; text: string }>;
    };
    const text = out.content[0]?.text ?? "";
    expect(text).not.toContain("top-secret-launch");
    expect(text).toMatch(/^weeek_list_boards failed \(weeek_[a-z_]+\): /);
  });

  it("non-WeeekError rejections propagate untouched", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.rejectAll(new Error("non-weeek failure"));
    registerWeeekListBoardsTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    await expect(
      srv.callHandler("weeek_list_boards", { project_id: 1 }),
    ).rejects.toThrow(/non-weeek/);
  });

  it("truncation: tight budget clips boards[] with truncated:true", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    const many = Array.from({ length: 100 }, (_, i) =>
      makeBoardPayload({
        id: i + 1,
        name: "B".repeat(60),
        projectId: 5,
      }),
    );
    wk.whenRequest("GET", `${WEEEK_PATH.boardsList}?projectId=5`, {
      status: 200,
      body: makeEnvelope("boards", many),
    });
    registerWeeekListBoardsTool(srv.server, {
      config: makeEnvConfig({ maxResponseChars: 1024 }),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_boards", {
      project_id: 5,
    })) as {
      structuredContent: { boards: unknown[]; truncated: boolean };
    };
    expect(out.structuredContent.truncated).toBe(true);
    expect(out.structuredContent.boards.length).toBeLessThan(100);
  });
});
