import { describe, it, expect } from "vitest";
import { listBoardColumns } from "../../../src/weeek/endpoints/boardColumns.js";
import { WeeekError } from "../../../src/weeek/types.js";
import { makeMockWeeekClient } from "../../helpers/mockWeeekClient.js";
import {
  makeEnvelope,
  makeBoardColumnPayload,
} from "../../helpers/factories.js";
import { silenceShapeWarn } from "../../helpers/shapeWarn.js";
import { WEEEK_PATH } from "../../helpers/paths.js";

describe("listBoardColumns", () => {
  silenceShapeWarn();

  it("happy: hits /tm/board-columns?boardId=<n> and maps envelope `boardColumns` to BoardColumnSummary[]", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", `${WEEEK_PATH.boardColumnsList}?boardId=7`, {
      status: 200,
      body: makeEnvelope("boardColumns", [
        makeBoardColumnPayload({ id: 1, name: "Todo", boardId: 7 }),
        makeBoardColumnPayload({ id: 2, name: "In Progress", boardId: 7 }),
        makeBoardColumnPayload({ id: 3, name: "Done", boardId: 7 }),
      ]),
    });
    const out = await listBoardColumns(m.client, 7);
    expect(out).toEqual([
      { id: 1, name: "Todo", boardId: 7 },
      { id: 2, name: "In Progress", boardId: 7 },
      { id: 3, name: "Done", boardId: 7 },
    ]);
    expect(m.requests()[0]?.path).toBe(
      `${WEEEK_PATH.boardColumnsList}?boardId=7`,
    );
  });

  it("path is hyphenated `/tm/board-columns?…`, NOT `/tm/boards/{id}/columns` (regression)", async () => {
    // The Weeek SPA returns a generic HTML 404 for `/tm/boards/{id}/columns`,
    // not a JSON envelope; the hyphenated query-param-scoped path is the
    // only one that works (probe 2026-05-13). This freezes the path.
    const m = makeMockWeeekClient();
    m.whenRequest("GET", `${WEEEK_PATH.boardColumnsList}?boardId=42`, {
      status: 200,
      body: makeEnvelope("boardColumns", []),
    });
    await listBoardColumns(m.client, 42);
    const path = m.requests()[0]?.path ?? "";
    expect(path.startsWith(`${WEEEK_PATH.boardColumnsList}?`)).toBe(true);
    expect(path).not.toContain("/tm/boards/42/columns");
  });

  // --- I7.5 (#34) tolerant shaping: inner-field drift degrades, never throws.

  it("Gate F: a wrong-typed inner field degrades, does not throw", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", `${WEEEK_PATH.boardColumnsList}?boardId=1`, {
      status: 200,
      body: makeEnvelope("boardColumns", [
        // `id` wrong-typed, `name` absent, `boardId` wrong-typed.
        makeBoardColumnPayload({ id: "x", name: undefined, boardId: "7" }),
      ]),
    });
    const out = await listBoardColumns(m.client, 1);
    expect(out).toEqual([{ id: 0, name: "", boardId: 0 }]);
  });

  it.each<[string, unknown]>([
    ["id", 0],
    ["name", ""],
    ["boardId", 0],
  ])(
    "missing required field `%s` degrades to its typed default (no throw)",
    async (field, expected) => {
      const column = makeBoardColumnPayload();
      delete column[field];
      const m = makeMockWeeekClient();
      m.whenRequest("GET", `${WEEEK_PATH.boardColumnsList}?boardId=1`, {
        status: 200,
        body: makeEnvelope("boardColumns", [column]),
      });
      const out = await listBoardColumns(m.client, 1);
      expect(out[0]).toHaveProperty(field, expected);
    },
  );

  it("present-but-non-array `boardColumns` degrades to [] (no throw)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", `${WEEEK_PATH.boardColumnsList}?boardId=1`, {
      status: 200,
      body: makeEnvelope("boardColumns", { not: "array" }),
    });
    expect(await listBoardColumns(m.client, 1)).toEqual([]);
  });

  it("drops a non-object entry, keeping its siblings", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", `${WEEEK_PATH.boardColumnsList}?boardId=1`, {
      status: 200,
      body: makeEnvelope("boardColumns", [
        makeBoardColumnPayload({ id: 1, name: "Todo" }),
        null,
        makeBoardColumnPayload({ id: 2, name: "Done" }),
      ]),
    });
    const out = await listBoardColumns(m.client, 1);
    expect(out).toEqual([
      { id: 1, name: "Todo", boardId: 7 },
      { id: 2, name: "Done", boardId: 7 },
    ]);
  });

  it("envelope negatives still throw (success:false)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", `${WEEEK_PATH.boardColumnsList}?boardId=1`, {
      status: 200,
      body: { success: false },
    });
    await expect(listBoardColumns(m.client, 1)).rejects.toBeInstanceOf(
      WeeekError,
    );
  });

  it("ignores extra fields (passthrough discipline)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", `${WEEEK_PATH.boardColumnsList}?boardId=1`, {
      status: 200,
      body: makeEnvelope("boardColumns", [
        makeBoardColumnPayload({
          id: 1,
          name: "Todo",
          position: 1,
          type: "open",
          sortOrder: 100,
        }),
      ]),
    });
    const out = await listBoardColumns(m.client, 1);
    expect(out[0]).toEqual({ id: 1, name: "Todo", boardId: 7 });
    expect(out[0]).not.toHaveProperty("position");
    expect(out[0]).not.toHaveProperty("type");
    expect(out[0]).not.toHaveProperty("sortOrder");
  });

  it("preserves upstream array order (no sort signal beyond order)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", `${WEEEK_PATH.boardColumnsList}?boardId=1`, {
      status: 200,
      body: makeEnvelope("boardColumns", [
        makeBoardColumnPayload({ id: 3, name: "C" }),
        makeBoardColumnPayload({ id: 1, name: "A" }),
        makeBoardColumnPayload({ id: 2, name: "B" }),
        makeBoardColumnPayload({ id: 5, name: "E" }),
        makeBoardColumnPayload({ id: 4, name: "D" }),
      ]),
    });
    const out = await listBoardColumns(m.client, 1);
    expect(out.map((c) => c.id)).toEqual([3, 1, 2, 5, 4]);
  });

  it("422 upstream (unknown boardId) surfaces as weeek_validation_error", async () => {
    // Probe 2026-05-13 (session B): `/tm/board-columns?boardId=999…` returns
    // HTTP 422 with `{success:false, errors:{boardId:[…]}}`. I8 (#42) maps
    // that to `weeek_validation_error` — the id the agent passed is wrong,
    // which is a different instruction than "the API drifted".
    const m = makeMockWeeekClient();
    m.whenRequest("GET", `${WEEEK_PATH.boardColumnsList}?boardId=999999`, {
      status: 422,
      body: {
        success: false,
        message: "The selected board id is invalid.",
        errors: { boardId: ["The selected board id is invalid."] },
      },
    });
    let err: unknown;
    try {
      await listBoardColumns(m.client, 999999);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WeeekError);
    expect((err as WeeekError).code).toBe("weeek_validation_error");
    expect((err as WeeekError).message).toBe("weeek http 422");
  });
});
