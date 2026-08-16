import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  shapeField,
  shapeList,
  resetShapeWarnDedup,
  type ShapeCtx,
} from "../../src/weeek/shape.js";
import { logger } from "../../src/logging/logger.js";

// Seam-2 (spec #32 Testing): drive the `shapeField` helper directly. This is
// the seam where the warn-on-fallback behaviour — dedup, the name-only
// guarantee, and the silent override — is cleanly observable (the endpoint
// seam only sees the degraded *value*, not the log).

const ctx = (over: Partial<ShapeCtx> = {}): ShapeCtx => ({
  endpoint: "list_things",
  field: "widget",
  ...over,
});

function spyWarn() {
  return vi.spyOn(logger, "warn").mockImplementation(() => {});
}

beforeEach(() => {
  // Dedup is per-process by design; isolate it between cases.
  resetShapeWarnDedup();
});

describe("shapeField — string family", () => {
  it("passes a valid string through unchanged, no warn", () => {
    const warn = spyWarn();
    expect(shapeField(ctx(), { kind: "string", value: "hello" })).toBe("hello");
    expect(warn).not.toHaveBeenCalled();
  });

  it("degrades a non-string to \"\" and warns", () => {
    const warn = spyWarn();
    expect(shapeField(ctx(), { kind: "string", value: 42 })).toBe("");
    expect(shapeField(ctx({ field: "b" }), { kind: "string", value: null })).toBe("");
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("shapeField — number family", () => {
  it("passes a valid number through unchanged, no warn", () => {
    const warn = spyWarn();
    expect(shapeField(ctx(), { kind: "number", value: 7 })).toBe(7);
    expect(shapeField(ctx(), { kind: "number", value: 0 })).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("degrades a non-number to 0 and warns", () => {
    const warn = spyWarn();
    expect(shapeField(ctx(), { kind: "number", value: "12" })).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("degrades NaN (not a schema-valid number) to 0 and warns", () => {
    const warn = spyWarn();
    expect(shapeField(ctx(), { kind: "number", value: Number.NaN })).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("shapeField — boolean family", () => {
  it("passes a valid boolean through unchanged, no warn", () => {
    const warn = spyWarn();
    expect(shapeField(ctx(), { kind: "boolean", value: true })).toBe(true);
    expect(shapeField(ctx(), { kind: "boolean", value: false })).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("degrades a non-boolean to false and warns", () => {
    const warn = spyWarn();
    expect(shapeField(ctx(), { kind: "boolean", value: "true" })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("shapeField — nullable family", () => {
  it("keeps a legitimate null/undefined as null WITHOUT warning (absence is not drift)", () => {
    const warn = spyWarn();
    expect(shapeField(ctx(), { kind: "nullable", of: "string", value: null })).toBeNull();
    expect(
      shapeField(ctx(), { kind: "nullable", of: "string", value: undefined }),
    ).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("passes a valid non-null value through unchanged, no warn", () => {
    const warn = spyWarn();
    expect(shapeField(ctx(), { kind: "nullable", of: "string", value: "x" })).toBe("x");
    expect(shapeField(ctx(), { kind: "nullable", of: "number", value: 3 })).toBe(3);
    expect(shapeField(ctx(), { kind: "nullable", of: "boolean", value: true })).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("degrades a present-but-wrong-type value to null (not the scalar default) and warns", () => {
    const warn = spyWarn();
    expect(shapeField(ctx(), { kind: "nullable", of: "string", value: 5 })).toBeNull();
    expect(shapeField(ctx({ field: "b" }), { kind: "nullable", of: "number", value: "5" })).toBeNull();
    expect(shapeField(ctx({ field: "c" }), { kind: "nullable", of: "boolean", value: 1 })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

describe("shapeField — array family", () => {
  it("maps each element through coerce, passing (element, index), no container warn", () => {
    const warn = spyWarn();
    const out = shapeField(ctx(), {
      kind: "array",
      value: ["a", "b"],
      coerce: (element, index) => `${String(element)}@${String(index)}`,
    });
    expect(out).toEqual(["a@0", "b@1"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("degrades a present-but-non-array collection to [] and warns", () => {
    const warn = spyWarn();
    const out = shapeField(ctx(), {
      kind: "array",
      value: { not: "an array" },
      coerce: (element) => element,
    });
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("returns [] for an empty array without warning", () => {
    const warn = spyWarn();
    const out = shapeField(ctx(), {
      kind: "array",
      value: [],
      coerce: (element) => element,
    });
    expect(out).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("shapeList — list container + entry shaping (#34)", () => {
  // A trivial entry parser: reads a `name` string tolerantly so the helper's
  // own container/entry handling is what's under test.
  const parseEntry = (obj: Record<string, unknown>): { name: string } => ({
    name: shapeField(
      { endpoint: "list_things", field: "name" },
      { kind: "string", value: obj["name"] },
    ),
  });

  it("maps object entries through parseEntry, no warn", () => {
    const warn = spyWarn();
    const out = shapeList({ endpoint: "list_things" }, [{ name: "a" }, { name: "b" }], parseEntry);
    expect(out).toEqual([{ name: "a" }, { name: "b" }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("degrades a present-but-non-array container to [] and warns `_container` once", () => {
    const warn = spyWarn();
    const out = shapeList({ endpoint: "list_things" }, { not: "array" }, parseEntry);
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual({ field: "list_things:_container" });
  });

  it("returns [] for an empty array without warning", () => {
    const warn = spyWarn();
    expect(shapeList({ endpoint: "list_things" }, [], parseEntry)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each<[string, unknown]>([
    ["a primitive", 42],
    ["a string", "nope"],
    ["null", null],
    ["a nested array", ["x"]],
  ])("drops a non-object entry (%s), keeping valid siblings", (_label, bad) => {
    const warn = spyWarn();
    const out = shapeList(
      { endpoint: "list_things" },
      [{ name: "keep" }, bad, { name: "also" }],
      parseEntry,
    );
    expect(out).toEqual([{ name: "keep" }, { name: "also" }]);
    // The dropped entry warns `_entry` (name family fires no warn here).
    expect(warn.mock.calls.some((c) => c[1]?.["field"] === "list_things:_entry")).toBe(true);
  });

  it("warns `_entry` ONCE across many dropped entries (dedup / rate-limit)", () => {
    const warn = spyWarn();
    const rows = Array.from({ length: 100 }, () => "not-an-object");
    const out = shapeList({ endpoint: "list_things" }, rows, parseEntry);
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual({ field: "list_things:_entry" });
  });

  it("the silent override degrades but emits no warn (container + entry)", () => {
    const warn = spyWarn();
    expect(shapeList({ endpoint: "list_things", silent: true }, 0, parseEntry)).toEqual([]);
    expect(
      shapeList({ endpoint: "list_things", silent: true }, ["x"], parseEntry),
    ).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("passes the entry index to parseEntry", () => {
    const withIndex = (_obj: Record<string, unknown>, index: number): number => index;
    const out = shapeList({ endpoint: "list_things" }, [{}, {}, {}], withIndex);
    expect(out).toEqual([0, 1, 2]);
  });
});

describe("shapeField — observability (dedup, override, name-only)", () => {
  it("warns ONCE per endpoint:field across repeated drift (dedup / rate-limit)", () => {
    const warn = spyWarn();
    for (let i = 0; i < 500; i++) {
      shapeField(ctx(), { kind: "number", value: "drift" });
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns separately for distinct endpoint:field pairs", () => {
    const warn = spyWarn();
    shapeField(ctx({ endpoint: "list_a", field: "x" }), { kind: "string", value: 1 });
    shapeField(ctx({ endpoint: "list_a", field: "y" }), { kind: "string", value: 1 });
    shapeField(ctx({ endpoint: "list_b", field: "x" }), { kind: "string", value: 1 });
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("resetShapeWarnDedup lets the same pair warn again", () => {
    const warn = spyWarn();
    shapeField(ctx(), { kind: "string", value: 1 });
    shapeField(ctx(), { kind: "string", value: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    resetShapeWarnDedup();
    shapeField(ctx(), { kind: "string", value: 1 });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("the silent override degrades but emits no warn", () => {
    const warn = spyWarn();
    expect(shapeField(ctx({ silent: true }), { kind: "string", value: 42 })).toBe("");
    expect(shapeField(ctx({ silent: true }), { kind: "array", value: 0, coerce: (e) => e })).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs the endpoint:field NAME only — never the drifted value (INVARIANT-2)", () => {
    // Real logger.warn (not mocked) → capture the raw stderr bytes and prove
    // a seeded sentinel value can never appear in them.
    const SENTINEL = "SENTINEL_LEAK_9f3a2b";
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    // Drift the sentinel through several families as a *value* of the wrong
    // type — each fires a fallback whose log must carry the name, not this.
    shapeField(ctx({ endpoint: "e1", field: "f1" }), {
      kind: "number",
      value: SENTINEL,
    });
    shapeField(ctx({ endpoint: "e2", field: "f2" }), {
      kind: "nullable",
      of: "number",
      value: SENTINEL,
    });
    shapeField(ctx({ endpoint: "e3", field: "f3" }), {
      kind: "array",
      value: { leak: SENTINEL },
      coerce: (e) => e,
    });

    const written = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(written).not.toContain(SENTINEL);
    // Sanity: the warnings DID fire and carry the safe endpoint:field names.
    expect(written).toContain("e1:f1");
    expect(written).toContain("e2:f2");
    expect(written).toContain("e3:f3");
  });
});
