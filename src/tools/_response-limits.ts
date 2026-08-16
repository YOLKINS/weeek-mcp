import type { EnvConfig } from "../config/env.js";
import { logger } from "../logging/logger.js";

// ASCII-safe truncation marker. U+2026 (`…`) keeps the visible width tight
// without committing to a longer ellipsis; the bracketed tag makes the source
// of the truncation unambiguous to a model that reads the description back.
// Must not contain \n / \r / control chars — stderr/stdout NDJSON would break.
const TRUNCATION_MARKER = "…[truncated]" as const;

interface TextContent {
  type: "text";
  text: string;
}

// MCP SDK expects `CallToolResult` to have a string index signature
// (`[x: string]: unknown`) so callers can attach `_meta`. We mirror that here
// so this helper's return type is assignment-compatible with the SDK handler.
export interface SuccessPayload<S extends Record<string, unknown>> {
  content: TextContent[];
  structuredContent: S;
  isError?: false | undefined;
  [k: string]: unknown;
}

export interface ErrorPayload {
  content: TextContent[];
  isError: true;
  [k: string]: unknown;
}

export type ToolPayload<S extends Record<string, unknown>> =
  | SuccessPayload<S>
  | ErrorPayload;

// The signal this module owns (INVARIANT-5). A handler builds its structured
// content and hands it over with a pre-gate `truncated: false`; the value that
// actually reaches the client is the one a strategy below decides.
export interface TruncationSignal {
  truncated: boolean;
}

// Structured content as it leaves the gate: whatever the handler built, plus
// the signal — carried in the type rather than asserted onto it (RETRO-19).
// `S & TruncationSignal` is assignable back to `S`, so a handler's own view of
// its payload is unchanged; what the intersection buys is that a strategy
// physically cannot return a payload without `truncated`.
export type GatedStructured<S extends Record<string, unknown>> = S &
  TruncationSignal;

// Generic in the payload it clips, so the shape a handler passed in survives
// the round trip. Every `return` inside a strategy spreads `structured`, which
// TypeScript types as an intersection with the literal fields added — that is
// what makes `GatedStructured<S>` provable here instead of asserted.
type Strategy = <S extends Record<string, unknown>>(
  structured: S,
  budget: number,
) => GatedStructured<S>;

// INVARIANT (parallels `entries[]` in `registry.ts`): every key here MUST be
// the first argument passed to `server.registerTool(...)` in some `*.tool.ts`
// — registry table is the source of truth for tool names. `ping` and
// `weeek_get_me` are deliberately absent: their payloads are fixed mini
// objects bounded well under the min budget (1024), so adding `truncated` to
// their outputSchema would be dead code that confuses the agent.
const STRATEGIES: Record<string, Strategy> = {
  weeek_list_projects: makeListStrategy("projects"),
  weeek_get_project: truncateDetailWithDescription,
  weeek_list_tasks: makeListStrategy("tasks"),
  weeek_list_members: makeListStrategy("members"),
  weeek_list_tags: makeListStrategy("tags"),
  weeek_get_task: truncateDetailWithDescription,
  // I8 (#43): a write returns the same task-detail shape a read does, so it
  // inherits the same byte-budget strategy — `description` is the one
  // variable-length field on the payload.
  weeek_complete_task: truncateDetailWithDescription,
  weeek_move_task: truncateDetailWithDescription,
  weeek_create_task: truncateDetailWithDescription,
  weeek_update_task: truncateDetailWithDescription,
  weeek_set_task_mr_link: truncateDetailWithDescription,
  weeek_list_boards: makeListStrategy("boards"),
  weeek_list_board_columns: makeListStrategy("boardColumns"),
};

export function applyResponseLimits<S extends Record<string, unknown>>(
  toolName: string,
  payload: ToolPayload<S>,
  config: Pick<EnvConfig, "maxResponseChars">,
): ToolPayload<S> {
  // Error path: structuredContent is absent and the agent already gets a
  // stable `weeek_<code>` text. Truncation has nothing to clip and would only
  // risk dropping the only signal the agent has.
  if (payload.isError === true) return payload;
  const strategy = STRATEGIES[toolName];
  if (!strategy) return payload;

  const budget = config.maxResponseChars;
  const before = JSON.stringify(payload.structuredContent).length;
  const sc = strategy(payload.structuredContent, budget);
  const after = JSON.stringify(sc).length;

  if (sc !== payload.structuredContent && after !== before) {
    // Metric-only: never log titles/ids/descriptions/secrets. Same discipline
    // as `WeeekError` (`code` + `status`, no body fragments).
    logger.info("response truncated", {
      tool: toolName,
      maxResponseChars: budget,
      originalChars: before,
      truncatedChars: after,
    });
  }
  // Named at the gated shape because that is what this module produces: a
  // success payload whose structured content carries `truncated`. The
  // guarantee is enforced by `Strategy`'s return type above, not by this
  // annotation; the annotation is where it is legible. It goes back out under
  // the wider `ToolPayload<S>` because the two branches above hand back
  // payloads the gate never touched (an error, or a tool with no strategy),
  // and those genuinely carry no signal.
  const gated: SuccessPayload<GatedStructured<S>> = {
    ...payload,
    structuredContent: sc,
  };
  return gated;
}

function makeListStrategy(listKey: string): Strategy {
  return <S extends Record<string, unknown>>(structured: S, budget: number) => {
    const items = structured[listKey];
    if (!Array.isArray(items)) {
      // Defensive: tool handlers always populate the list key with an array,
      // but if a future refactor regresses this we still emit a valid
      // `truncated:false` payload rather than throwing.
      return { ...structured, truncated: false };
    }

    // Cheap pre-check: untouched payload + truncated:false fits within budget.
    const candidate = { ...structured, [listKey]: items, truncated: false };
    if (JSON.stringify(candidate).length <= budget) return candidate;

    // Binary search for the largest k such that the truncated payload still
    // fits. O(log n) JSON.stringify calls; n≤100 (perPage cap), so under 1ms.
    // Invariant: fits(0) is true under the min budget (1024) — the envelope
    // around an empty array stays well under 100 chars.
    const fits = (k: number): boolean =>
      JSON.stringify({
        ...structured,
        [listKey]: items.slice(0, k),
        truncated: true,
      }).length <= budget;

    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (fits(mid)) lo = mid;
      else hi = mid - 1;
    }
    return {
      ...structured,
      [listKey]: items.slice(0, lo),
      truncated: true,
    };
  };
}

function truncateDetailWithDescription<S extends Record<string, unknown>>(
  structured: S,
  budget: number,
): GatedStructured<S> {
  const candidate = { ...structured, truncated: false };
  if (JSON.stringify(candidate).length <= budget) return candidate;

  const description = structured["description"];
  // `description` is the only variable-length field on these detail shapes
  // (TaskDetail, ProjectDetail). The fixed-shape neighbours (ids, booleans,
  // small enums, short titles) never push the envelope past the min budget
  // on their own, so clipping `description` is the single lever needed.
  if (typeof description !== "string") {
    return { ...structured, truncated: true };
  }

  // String.prototype.slice cuts at UTF-16 code units, which can split a
  // surrogate pair. JSON.stringify escapes lone surrogates safely (`\uD83D`),
  // and the trailing marker signals the cut, so this is acceptable for
  // a truncation gate: we trade exact glyph boundaries for predictable bytes.
  const fits = (k: number): boolean => {
    const desc = description.slice(0, k) + TRUNCATION_MARKER;
    return JSON.stringify({
      ...structured,
      description: desc,
      truncated: true,
    }).length <= budget;
  };

  if (!fits(0)) {
    // Pathological: even an empty description plus the marker overflows.
    // Replace with the marker alone so the schema (z.string().nullable())
    // is still satisfied; the agent sees a clipped task rather than nothing.
    return { ...structured, description: TRUNCATION_MARKER, truncated: true };
  }
  let lo = 0;
  let hi = description.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return {
    ...structured,
    description: description.slice(0, lo) + TRUNCATION_MARKER,
    truncated: true,
  };
}
