import type { ToolSelection } from "../tools/registry.js";

/**
 * Optional parenthetical for a tool name, keyed by name. Prose only — nothing
 * here is load-bearing, and a name whose tool the gate hid is simply never
 * looked up, so this table cannot put an unexposed identifier into the string.
 * That matters: INVARIANT-14 forbids naming a tool the current gate does not
 * advertise.
 */
const HINTS: Readonly<Record<string, string>> = {
  ping: "health",
  weeek_get_me: "current account",
  weeek_list_tasks: "paginated via offset/per_page + hasMore",
};

/** Tools whose `description` the response limiter may clip. */
const CLIPPING_DETAIL_TOOLS = ["weeek_get_task", "weeek_get_project"] as const;

/**
 * Build the server's `instructions` string from the surface the gate actually
 * selected.
 *
 * Until 1.0.1 this was a string literal in `src/index.ts`, and it had gone
 * stale the way a hand-maintained mirror of a computed thing always does: it
 * described a read-only server with ten tools and closed with "Mutating tools
 * land in I8+" — while I8 had shipped, and `READ_ONLY=false` was handing the
 * agent five write tools the prose neither listed nor admitted existed.
 * Deriving it removes the mirror; INVARIANT-14
 * (`tests/invariants/tools-list-wire.test.ts`) pins the two together on the
 * wire so a future tool cannot re-open the gap.
 *
 * The `instructions` field is advisory by spec — `tools/list` is what actually
 * declares the surface, and it was correct throughout. This is about not
 * telling the agent something false.
 */
export function buildInstructions(selected: readonly ToolSelection[]): string {
  const writes = selected.filter((t) => !t.readOnly);
  const names = selected.map((t) => {
    const hint = HINTS[t.name];
    return hint === undefined ? `\`${t.name}\`` : `\`${t.name}\` (${hint})`;
  });

  // The read-only claim. The guard is «zero writes», not «`READ_ONLY` is
  // set»: an operator can set `READ_ONLY=false` and then allowlist nothing but
  // read tools, and that server IS read-only in the only sense an agent cares
  // about.
  //
  // The `selected.length === 0` arm is not reachable in production —
  // `selectTools` throws on an empty selection before any of this runs — but
  // it is written out rather than left to fall through, because
  // `writes.length === 0` is VACUOUSLY true for an empty array. Fall through
  // and the server introduces itself as read-only when it has no tools at all:
  // technically true, and precisely the kind of true statement that reads as
  // reassurance. Pinned by `tests/server/instructions.test.ts`.
  const opening =
    selected.length === 0
      ? "MCP server for Weeek — no tools are registered on this instance. "
      : writes.length === 0
        ? "Read-only MCP server for Weeek. "
        : "MCP server for Weeek, running with write tools enabled — " +
          `${String(writes.length)} of the tools below MODIFY Weeek data and ` +
          "their effects are not undoable from here. Confirm intent before " +
          "calling one. ";

  const clipping = CLIPPING_DETAIL_TOOLS.filter((n) =>
    selected.some((t) => t.name === n),
  );
  const clippingClause =
    clipping.length === 0
      ? ""
      : `; ${clipping.join(" / ")} may clip description with the trailing marker`;

  return (
    opening +
    (names.length === 0 ? "" : `Available tools: ${names.join(", ")}. `) +
    "Every tool input is snake_case (`project_id`, `task_id`, " +
    "`board_id`, `per_page`) — camelCase arguments are rejected. " +
    "Server-side gates: READ_ONLY (default on) hides any tool whose " +
    "annotations.readOnlyHint !== true; ENABLED_TOOLS (optional, " +
    "comma-separated) restricts registration to listed names; " +
    "MAX_RESPONSE_CHARS limits structuredContent size — list tools may " +
    `return fewer items with truncated:true${clippingClause}. ` +
    "All three gates compose."
  );
}
