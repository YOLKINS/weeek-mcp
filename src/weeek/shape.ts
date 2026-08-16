// Tolerant inner-field shaping (I7.5 / ADR 0003 — "drift policy: envelope
// strict, fields tolerant").
//
// This is the *inner* half of the two-layer parser. The **envelope** layer
// (`parseWeeekResponse` in `unwrap.ts`) stays strict — a broken envelope means
// "not the API I think I'm talking to" and must fail loud. Everything past a
// successfully-unwrapped resource flows through `shapeField` and can no longer
// throw on drift: each inner field degrades to a schema-valid default of its
// declared kind (`""` / `null` / `[]` / `0` / `false`) instead of raising
// `weeek_invalid_response`. A single cosmetic upstream rename now degrades one
// field on one row rather than erroring the whole list.
//
// No endpoint is wired to this helper yet — it lands beside the existing strict
// guards (#33 is the foundation; #34–#37 migrate the parsers). The `outputSchema`
// of every read tool is frozen (Gate B), so every degraded value stays
// schema-valid and I7.5 remains a refactor, not a break.

import { logger } from "../logging/logger.js";

/**
 * Identifies which field is being shaped. `endpoint:field` is both the dedup
 * key and the *only* thing ever logged when a fallback fires — never the
 * drifted value (INVARIANT-2).
 */
export interface ShapeCtx {
  /** Short endpoint tag, e.g. `"list_tasks"` (not a URL). */
  readonly endpoint: string;
  /** Field name, e.g. `"priority"`. */
  readonly field: string;
  /**
   * Override: when `true`, a fallback still returns a schema-valid default but
   * emits no warn. Lets an operator run quietly once a known drift is
   * acknowledged (spec #32 user story 15).
   */
  readonly silent?: boolean;
}

/** The three required-scalar families. */
type Scalar = "string" | "number" | "boolean";

/**
 * A field-shaping request. Discriminated by `kind`:
 *  - `string` / `number` / `boolean` — required scalar; drift → `""` / `0` /
 *    `false`.
 *  - `nullable` — scalar-or-`null`; a legitimate `null`/absent stays `null`
 *    (not a fallback), a present-but-wrong-type value degrades to `null`.
 *  - `array` — drift (present but not an array) → `[]`; otherwise each element
 *    is mapped through the caller-supplied `coerce` (the per-element policy,
 *    e.g. a nested object parser, is the caller's, not this helper's).
 */
export type ShapeSpec =
  | { readonly kind: "string"; readonly value: unknown }
  | { readonly kind: "number"; readonly value: unknown }
  | { readonly kind: "boolean"; readonly value: unknown }
  | { readonly kind: "nullable"; readonly of: Scalar; readonly value: unknown }
  | {
      readonly kind: "array";
      readonly value: unknown;
      readonly coerce: (element: unknown, index: number) => unknown;
    };

// Per-process dedup of fallback warnings: one line per `endpoint:field`, never
// once-per-row. Kept here — the logger stays stateless (INVARIANT discipline in
// CLAUDE.md's logging section) — and is the rate limiter: a drifted field on a
// 500-row list logs once, not 500 times (spec #32 user story 12).
const warnedPairs = new Set<string>();

/**
 * Test-only: clear the per-process fallback-warn dedup between test cases.
 * Never called in production — the dedup is meant to persist for the life of
 * the process.
 */
export function resetShapeWarnDedup(): void {
  warnedPairs.clear();
}

function warnFallback(ctx: ShapeCtx): void {
  if (ctx.silent === true) return;
  const pair = `${ctx.endpoint}:${ctx.field}`;
  if (warnedPairs.has(pair)) return;
  warnedPairs.add(pair);
  // NAME ONLY. The drifted value never enters the log (INVARIANT-1: stderr
  // only, via the structured logger; INVARIANT-2: the payload carries the
  // `endpoint:field` name and nothing derived from the value). `field` is NOT
  // in the logger's REDACT_KEYS set, so safety here rests entirely on the
  // `pair` being a static caller tag — every `ShapeCtx.endpoint`/`.field` must
  // stay a constant identifier (never a value), which the type's JSDoc pins.
  logger.warn("weeek response field drifted; degraded to schema-valid default", {
    field: pair,
  });
}

const EMPTY: Readonly<Record<Scalar, string | number | boolean>> = {
  string: "",
  number: 0,
  boolean: false,
};

function matchesScalar(of: Scalar, value: unknown): boolean {
  if (of === "string") return typeof value === "string";
  // `Number.isFinite` also rejects `NaN` / `Infinity`, which JSON can never
  // carry but an in-memory drift could — neither is a schema-valid number.
  if (of === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === "boolean";
}

function shapeScalar(
  ctx: ShapeCtx,
  of: Scalar,
  value: unknown,
): string | number | boolean {
  if (matchesScalar(of, value)) {
    return value as string | number | boolean;
  }
  warnFallback(ctx);
  return EMPTY[of];
}

function shapeNullable(
  ctx: ShapeCtx,
  of: Scalar,
  value: unknown,
): string | number | boolean | null {
  // A legitimately absent value (null/undefined) → null, no warn: nullable
  // fields are *expected* to be null; that is not drift.
  if (value === null || value === undefined) return null;
  if (matchesScalar(of, value)) {
    return value as string | number | boolean;
  }
  // Present but wrong type: real drift → warn, degrade to the nullable default
  // (`null`), not to the scalar's empty default.
  warnFallback(ctx);
  return null;
}

function shapeArray<T>(
  ctx: ShapeCtx,
  value: unknown,
  coerce: (element: unknown, index: number) => T,
): T[] {
  if (Array.isArray(value)) {
    return (value as unknown[]).map((element, index) => coerce(element, index));
  }
  // A present-but-non-array collection (e.g. `tasks` arrives as an object)
  // degrades to `[]` rather than throwing — a container-shape drift must not
  // defeat tolerant shaping (spec #32 user story 17).
  warnFallback(ctx);
  return [];
}

/**
 * Coerce one inner field to a schema-valid default of its declared kind
 * instead of throwing. The load-bearing contract: **no inner field's drift can
 * throw.** When a fallback fires, a de-duplicated `warn` line goes to stderr
 * carrying the `endpoint:field` name only.
 */
export function shapeField(
  ctx: ShapeCtx,
  spec: { readonly kind: "string"; readonly value: unknown },
): string;
export function shapeField(
  ctx: ShapeCtx,
  spec: { readonly kind: "number"; readonly value: unknown },
): number;
export function shapeField(
  ctx: ShapeCtx,
  spec: { readonly kind: "boolean"; readonly value: unknown },
): boolean;
export function shapeField(
  ctx: ShapeCtx,
  spec: { readonly kind: "nullable"; readonly of: "string"; readonly value: unknown },
): string | null;
export function shapeField(
  ctx: ShapeCtx,
  spec: { readonly kind: "nullable"; readonly of: "number"; readonly value: unknown },
): number | null;
export function shapeField(
  ctx: ShapeCtx,
  spec: { readonly kind: "nullable"; readonly of: "boolean"; readonly value: unknown },
): boolean | null;
export function shapeField<T>(
  ctx: ShapeCtx,
  spec: {
    readonly kind: "array";
    readonly value: unknown;
    readonly coerce: (element: unknown, index: number) => T;
  },
): T[];
export function shapeField(ctx: ShapeCtx, spec: ShapeSpec): unknown {
  switch (spec.kind) {
    case "string":
    case "number":
    case "boolean":
      return shapeScalar(ctx, spec.kind, spec.value);
    case "nullable":
      return shapeNullable(ctx, spec.of, spec.value);
    case "array":
      return shapeArray(ctx, spec.value, spec.coerce);
  }
}

/** The endpoint-and-override half of a `ShapeCtx`, with no per-field name. */
export interface ListCtx {
  /** Short endpoint tag, e.g. `"list_projects"` (not a URL). */
  readonly endpoint: string;
  /** When `true`, structural fallbacks degrade silently (no warn). */
  readonly silent?: boolean;
}

/**
 * Tolerantly shape a **list** resource — the top-level collection a list
 * endpoint returns after the envelope has been unwrapped. Two structural drifts
 * degrade instead of throwing, so a container-shape change upstream cannot take
 * the whole endpoint down:
 *
 *  - the container is present (the envelope already proved the key) but **not an
 *    array** → `[]`, warned as `endpoint:_container` (spec #32 user story 17);
 *  - an **entry is not a plain object** → dropped, warned as `endpoint:_entry`
 *    (ADR 0003 boundary case: drop-with-warn — never a throw, and never a
 *    fully-synthetic all-defaults row).
 *
 * Every surviving entry is a plain object handed to `parseEntry`, which is
 * expected to shape its own inner fields through `shapeField` and therefore also
 * never throws. The result is that no drift downstream of the envelope — neither
 * a renamed field nor a mangled container — can throw for a list endpoint.
 */
export function shapeList<T>(
  ctx: ListCtx,
  value: unknown,
  parseEntry: (entry: Record<string, unknown>, index: number) => T,
): T[] {
  // `silent` is coerced to a definite boolean so the `ShapeCtx` passed to
  // `warnFallback` never carries an explicit `undefined` (exactOptionalPropertyTypes).
  const silent = ctx.silent === true;
  if (!Array.isArray(value)) {
    warnFallback({ endpoint: ctx.endpoint, field: "_container", silent });
    return [];
  }
  const out: T[] = [];
  (value as readonly unknown[]).forEach((element, index) => {
    // Same narrowing as `asJson`: `typeof === "object"` also admits arrays and
    // `null`, so exclude both — an entry must be a plain, key-indexable object.
    if (element === null || typeof element !== "object" || Array.isArray(element)) {
      warnFallback({ endpoint: ctx.endpoint, field: "_entry", silent });
      return;
    }
    out.push(parseEntry(element as Record<string, unknown>, index));
  });
  return out;
}
