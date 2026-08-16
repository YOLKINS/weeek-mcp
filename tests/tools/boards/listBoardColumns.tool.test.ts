import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { registerWeeekListBoardColumnsTool } from "../../../src/tools/boards/listBoardColumns.tool.js";
import { WeeekError } from "../../../src/weeek/types.js";
import { humanMessage } from "../../../src/weeek/humanMessage.js";
import { logger } from "../../../src/logging/logger.js";
import {
  makeEnvConfig,
  makeEnvelope,
  makeBoardColumnPayload,
} from "../../helpers/factories.js";
import { makeMockMcpServer } from "../../helpers/mockMcpServer.js";
import { makeMockWeeekClient } from "../../helpers/mockWeeekClient.js";
import { WEEEK_PATH } from "../../helpers/paths.js";

describe("registerWeeekListBoardColumnsTool", () => {
  beforeEach(() => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "info").mockImplementation(() => {});
  });

  it("registers with annotations + outputSchema {boardColumns, truncated}", () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    registerWeeekListBoardColumnsTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const reg = srv.byName("weeek_list_board_columns");
    expect(reg).toBeDefined();
    expect(reg?.config.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    const outputShape = reg?.config.outputSchema as Record<string, unknown>;
    expect(outputShape["boardColumns"]).toBeDefined();
    expect(outputShape["truncated"]).toBeDefined();
  });

  it("inputSchema requires board_id (z.ZodNumber, not optional)", () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    registerWeeekListBoardColumnsTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const inputShape = srv.byName("weeek_list_board_columns")?.config
      .inputSchema as Record<string, unknown>;
    expect(inputShape["board_id"]).toBeInstanceOf(z.ZodNumber);
  });

  it("happy: text '<n> column(s)' + structuredContent + truncated:false; path is hyphenated `/tm/board-columns`", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.whenRequest("GET", `${WEEEK_PATH.boardColumnsList}?boardId=7`, {
      status: 200,
      body: makeEnvelope("boardColumns", [
        makeBoardColumnPayload({ id: 1, name: "Todo", boardId: 7 }),
        makeBoardColumnPayload({ id: 2, name: "In Progress", boardId: 7 }),
        makeBoardColumnPayload({ id: 3, name: "Done", boardId: 7 }),
      ]),
    });
    registerWeeekListBoardColumnsTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_board_columns", {
      board_id: 7,
    })) as {
      content: Array<{ type: string; text: string }>;
      structuredContent: { boardColumns: unknown[]; truncated: boolean };
    };
    expect(out.content[0]?.text).toBe("3 column(s)");
    expect(out.structuredContent.truncated).toBe(false);
    expect(out.structuredContent.boardColumns).toHaveLength(3);
    const path = wk.requests()[0]?.path ?? "";
    expect(path.startsWith(`${WEEEK_PATH.boardColumnsList}?`)).toBe(true);
    expect(path).toContain("boardId=7");
  });

  it("preserves upstream column order through the tool output", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.whenRequest("GET", `${WEEEK_PATH.boardColumnsList}?boardId=7`, {
      status: 200,
      body: makeEnvelope("boardColumns", [
        makeBoardColumnPayload({ id: 3, name: "C" }),
        makeBoardColumnPayload({ id: 1, name: "A" }),
        makeBoardColumnPayload({ id: 2, name: "B" }),
      ]),
    });
    registerWeeekListBoardColumnsTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_board_columns", {
      board_id: 7,
    })) as {
      structuredContent: { boardColumns: Array<{ id: number }> };
    };
    expect(out.structuredContent.boardColumns.map((c) => c.id)).toEqual([
      3, 1, 2,
    ]);
  });

  it("WeeekError → isError:true with prefix + humanMessage (INVARIANT-7)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    const err = new WeeekError({
      code: "weeek_invalid_response",
      message: "weeek http 422",
      status: 422,
    });
    wk.rejectAll(err);
    registerWeeekListBoardColumnsTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_board_columns", {
      board_id: 999999,
    })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(out.isError).toBe(true);
    const text = out.content[0]?.text ?? "";
    expect(text).toMatch(
      /^weeek_list_board_columns failed \(weeek_invalid_response\): /,
    );
    expect(text).toContain(humanMessage(err));
  });

  it("WeeekError text never echoes err.message body fragments (INVARIANT-2)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.rejectAll(
      new WeeekError({
        code: "weeek_server_error",
        message: "leak: column=top-secret-launch",
        status: 500,
      }),
    );
    registerWeeekListBoardColumnsTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_board_columns", {
      board_id: 1,
    })) as {
      content: Array<{ type: string; text: string }>;
    };
    const text = out.content[0]?.text ?? "";
    expect(text).not.toContain("top-secret-launch");
    expect(text).toMatch(
      /^weeek_list_board_columns failed \(weeek_[a-z_]+\): /,
    );
  });

  it("non-WeeekError rejections propagate untouched", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.rejectAll(new Error("non-weeek failure"));
    registerWeeekListBoardColumnsTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    await expect(
      srv.callHandler("weeek_list_board_columns", { board_id: 1 }),
    ).rejects.toThrow(/non-weeek/);
  });

  it("truncation: tight budget clips boardColumns[] with truncated:true", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    const many = Array.from({ length: 100 }, (_, i) =>
      makeBoardColumnPayload({
        id: i + 1,
        name: "C".repeat(60),
        boardId: 7,
      }),
    );
    wk.whenRequest("GET", `${WEEEK_PATH.boardColumnsList}?boardId=7`, {
      status: 200,
      body: makeEnvelope("boardColumns", many),
    });
    registerWeeekListBoardColumnsTool(srv.server, {
      config: makeEnvConfig({ maxResponseChars: 1024 }),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_board_columns", {
      board_id: 7,
    })) as {
      structuredContent: { boardColumns: unknown[]; truncated: boolean };
    };
    expect(out.structuredContent.truncated).toBe(true);
    expect(out.structuredContent.boardColumns.length).toBeLessThan(100);
  });
});
