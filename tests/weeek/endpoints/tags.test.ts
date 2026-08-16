import { describe, it, expect } from "vitest";
import { listTags } from "../../../src/weeek/endpoints/tags.js";
import { WeeekError } from "../../../src/weeek/types.js";
import { makeMockWeeekClient } from "../../helpers/mockWeeekClient.js";
import {
  makeEnvelope,
  makeTagPayload,
} from "../../helpers/factories.js";
import { silenceShapeWarn } from "../../helpers/shapeWarn.js";
import { WEEEK_PATH } from "../../helpers/paths.js";

describe("listTags", () => {
  silenceShapeWarn();

  it("happy: maps array to TagSummary[]", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.tagsList, {
      status: 200,
      body: makeEnvelope("tags", [
        makeTagPayload({ id: 1, title: "p0", color: "#f00" }),
        makeTagPayload({ id: 2, title: "p1", color: "#0f0" }),
      ]),
    });
    const out = await listTags(m.client);
    expect(out).toEqual([
      { id: 1, title: "p0", color: "#f00" },
      { id: 2, title: "p1", color: "#0f0" },
    ]);
  });

  it("returns [] for an empty list", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.tagsList, {
      status: 200,
      body: makeEnvelope("tags", []),
    });
    expect(await listTags(m.client)).toEqual([]);
  });

  // --- I7.5 (#35) tolerant shaping: inner-field drift degrades, never throws.

  it("loose by design: a drifted id degrades to 0, not throws (RETRO-22)", async () => {
    // Was «id of 0 is currently accepted (no positive constraint at endpoint)»
    // — a test that enshrined a strictness gap. Reframed for ADR 0003: a
    // drifted `id` (here a wrong-typed string) degrades to the tolerant `0`
    // default rather than erroring the whole list, while a legitimate `id: 0`
    // still flows through unchanged (no `id ≥ 1` constraint here). Both land on
    // `0`, but only the first is a fallback.
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.tagsList, {
      status: 200,
      body: makeEnvelope("tags", [
        makeTagPayload({ id: "not-a-number" as unknown as number }),
        makeTagPayload({ id: 0 }),
      ]),
    });
    const out = await listTags(m.client);
    expect(out[0]?.id).toBe(0); // drifted → degraded to 0
    expect(out[1]?.id).toBe(0); // genuine 0 → passed through
  });

  it("Gate F: a wrong-typed inner field degrades, does not throw", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.tagsList, {
      status: 200,
      body: makeEnvelope("tags", [
        // `id` wrong-typed, `title` absent, `color` wrong-typed.
        makeTagPayload({
          id: "x" as unknown as number,
          title: undefined,
          color: 7 as unknown as string,
        }),
      ]),
    });
    const out = await listTags(m.client);
    expect(out).toEqual([{ id: 0, title: "", color: "" }]);
  });

  it.each<[string, unknown]>([
    ["id", 0],
    ["title", ""],
    ["color", ""],
  ])(
    "missing required field `%s` degrades to its typed default (no throw)",
    async (field, expected) => {
      const tag = makeTagPayload();
      delete tag[field];
      const m = makeMockWeeekClient();
      m.whenRequest("GET", WEEEK_PATH.tagsList, {
        status: 200,
        body: makeEnvelope("tags", [tag]),
      });
      const out = await listTags(m.client);
      expect(out[0]).toHaveProperty(field, expected);
    },
  );

  it("present-but-non-array `tags` degrades to [] (no throw)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.tagsList, {
      status: 200,
      body: makeEnvelope("tags", { not: "array" }),
    });
    expect(await listTags(m.client)).toEqual([]);
  });

  it("drops a non-object entry, keeping its siblings", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.tagsList, {
      status: 200,
      body: makeEnvelope("tags", [
        makeTagPayload({ id: 1, title: "keep" }),
        42,
        makeTagPayload({ id: 3, title: "also-keep" }),
      ]),
    });
    const out = await listTags(m.client);
    expect(out).toEqual([
      { id: 1, title: "keep", color: "#abc" },
      { id: 3, title: "also-keep", color: "#abc" },
    ]);
  });

  it("envelope negatives still throw (success:false)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.tagsList, {
      status: 200,
      body: { success: false },
    });
    await expect(listTags(m.client)).rejects.toBeInstanceOf(WeeekError);
  });
});
