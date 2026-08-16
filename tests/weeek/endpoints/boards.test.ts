import { describe, it, expect } from "vitest";
import { listBoards } from "../../../src/weeek/endpoints/boards.js";
import { WeeekError } from "../../../src/weeek/types.js";
import { makeMockWeeekClient } from "../../helpers/mockWeeekClient.js";
import {
  makeEnvelope,
  makeBoardPayload,
} from "../../helpers/factories.js";
import { silenceShapeWarn } from "../../helpers/shapeWarn.js";
import { WEEEK_PATH } from "../../helpers/paths.js";

describe("listBoards", () => {
  silenceShapeWarn();

  it("happy: hits /tm/boards?projectId=<n> and maps envelope to BoardSummary[]", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", `${WEEEK_PATH.boardsList}?projectId=5`, {
      status: 200,
      body: makeEnvelope("boards", [
        makeBoardPayload({ id: 1, name: "Backlog", projectId: 5 }),
        makeBoardPayload({ id: 2, name: "Sprint", projectId: 5 }),
      ]),
    });
    const out = await listBoards(m.client, 5);
    expect(out).toEqual([
      { id: 1, name: "Backlog", projectId: 5, isPrivate: false },
      { id: 2, name: "Sprint", projectId: 5, isPrivate: false },
    ]);
    expect(m.requests()[0]?.path).toBe(
      `${WEEEK_PATH.boardsList}?projectId=5`,
    );
  });

  // --- I7.5 (#34) tolerant shaping: inner-field drift degrades, never throws.

  it("Gate F: a wrong-typed inner field degrades, does not throw", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", `${WEEEK_PATH.boardsList}?projectId=1`, {
      status: 200,
      body: makeEnvelope("boards", [
        // `name` wrong-typed, `projectId` absent, `isPrivate` wrong-typed.
        makeBoardPayload({ name: 42, projectId: undefined, isPrivate: "yes" }),
      ]),
    });
    const out = await listBoards(m.client, 1);
    expect(out).toEqual([
      { id: 1, name: "", projectId: 0, isPrivate: false },
    ]);
  });

  it.each<[string, unknown]>([
    ["id", 0],
    ["name", ""],
    ["projectId", 0],
    ["isPrivate", false],
  ])(
    "missing required field `%s` degrades to its typed default (no throw)",
    async (field, expected) => {
      const board = makeBoardPayload();
      delete board[field];
      const m = makeMockWeeekClient();
      m.whenRequest("GET", `${WEEEK_PATH.boardsList}?projectId=1`, {
        status: 200,
        body: makeEnvelope("boards", [board]),
      });
      const out = await listBoards(m.client, 1);
      expect(out[0]).toHaveProperty(field, expected);
    },
  );

  it("present-but-non-array `boards` degrades to [] (no throw)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", `${WEEEK_PATH.boardsList}?projectId=1`, {
      status: 200,
      body: makeEnvelope("boards", { not: "array" }),
    });
    expect(await listBoards(m.client, 1)).toEqual([]);
  });

  it("drops a non-object entry, keeping its siblings", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", `${WEEEK_PATH.boardsList}?projectId=1`, {
      status: 200,
      body: makeEnvelope("boards", [
        makeBoardPayload({ id: 1, name: "keep" }),
        42,
        makeBoardPayload({ id: 3, name: "also-keep" }),
      ]),
    });
    const out = await listBoards(m.client, 1);
    expect(out).toEqual([
      { id: 1, name: "keep", projectId: 5, isPrivate: false },
      { id: 3, name: "also-keep", projectId: 5, isPrivate: false },
    ]);
  });

  it("envelope negatives still throw (success:false)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", `${WEEEK_PATH.boardsList}?projectId=1`, {
      status: 200,
      body: { success: false },
    });
    await expect(listBoards(m.client, 1)).rejects.toBeInstanceOf(WeeekError);
  });

  it("ignores extra fields (passthrough discipline)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", `${WEEEK_PATH.boardsList}?projectId=1`, {
      status: 200,
      body: makeEnvelope("boards", [
        makeBoardPayload({
          id: 7,
          name: "Backlog",
          description: "ignored",
          customFields: [{ k: "v" }],
        }),
      ]),
    });
    const out = await listBoards(m.client, 1);
    expect(out[0]).toEqual({
      id: 7,
      name: "Backlog",
      projectId: 5,
      isPrivate: false,
    });
    expect(out[0]).not.toHaveProperty("description");
    expect(out[0]).not.toHaveProperty("customFields");
  });

  it("422 upstream (e.g. invalid projectId) surfaces as weeek_validation_error", async () => {
    // Mirrors the live `/tm/boards` without `projectId` shape — the tool
    // input layer enforces projectId, but a stale id can still 422.
    // I8 (#42): codeForStatus(422) is now `weeek_validation_error`, not the
    // `weeek_invalid_response` catch-all — the agent sent a bad id, the API
    // did not drift. This read-side change is intended.
    const m = makeMockWeeekClient();
    m.whenRequest("GET", `${WEEEK_PATH.boardsList}?projectId=999999`, {
      status: 422,
      body: {
        success: false,
        message: "Invalid project id.",
        errors: { projectId: ["The selected project id is invalid."] },
      },
    });
    let err: unknown;
    try {
      await listBoards(m.client, 999999);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WeeekError);
    expect((err as WeeekError).code).toBe("weeek_validation_error");
    // The per-field validation body never reaches the error message.
    expect((err as WeeekError).message).toBe("weeek http 422");
  });
});
