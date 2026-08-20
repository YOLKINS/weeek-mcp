import { describe, it, expect, vi } from "vitest";
import { buildInstructions } from "../../src/server/instructions.js";
import { selectTools, type ToolSelection } from "../../src/tools/registry.js";
import { logger } from "../../src/logging/logger.js";
import { makeEnvConfig } from "../helpers/factories.js";
import { READ_TOOLS, WRITE_TOOLS, ALL_TOOLS } from "../helpers/toolNames.js";

// The same tokenizer INVARIANT-14 uses on the wire. Kept literal in both
// places on purpose — see the comment at its other copy in
// `tests/invariants/tools-list-wire.test.ts` for why `[a-z_]+` must stay
// greedy.
function toolTokens(text: string): Set<string> {
  return new Set(text.match(/\b(ping|weeek_[a-z_]+)\b/g) ?? []);
}

function quiet(): void {
  vi.spyOn(logger, "info").mockImplementation(() => {});
  vi.spyOn(logger, "warn").mockImplementation(() => {});
}

function sel(names: readonly string[], readOnly = true): ToolSelection[] {
  return names.map((name) => ({ name, readOnly }));
}

describe("buildInstructions", () => {
  it("lists exactly the selected tools, in the order given", () => {
    quiet();
    const selected = selectTools(makeEnvConfig());
    const text = buildInstructions(selected);
    // Order, not just membership: the prose enumerates the surface a client
    // sees on `tools/list`, and that list is ordered.
    const inOrder = [...(text.match(/\b(ping|weeek_[a-z_]+)\b/g) ?? [])];
    const firstMentions = inOrder.filter(
      (n, i) => inOrder.indexOf(n) === i,
    );
    expect(firstMentions).toEqual([...READ_TOOLS]);
  });

  it("claims read-only when the selection contains no write tool", () => {
    quiet();
    const text = buildInstructions(selectTools(makeEnvConfig()));
    expect(text).toContain("Read-only MCP server for Weeek.");
    expect(text).not.toMatch(/MODIFY/);
  });

  it("drops the read-only claim and warns about mutation when writes are in", () => {
    quiet();
    const selected = selectTools(makeEnvConfig({ readOnly: false }));
    const text = buildInstructions(selected);
    expect(text).not.toContain("Read-only MCP server");
    expect(text).toContain("MODIFY Weeek data");
    // The count is derived, not written down.
    expect(text).toContain(`${String(WRITE_TOOLS.length)} of the tools below`);
    expect(toolTokens(text)).toEqual(new Set(ALL_TOOLS));
  });

  it("the 1.0.0 sign-off is gone", () => {
    quiet();
    for (const readOnly of [true, false]) {
      const text = buildInstructions(selectTools(makeEnvConfig({ readOnly })));
      expect(text).not.toContain("Mutating tools land in I8+");
      expect(text).not.toContain("I8");
    }
  });

  it("keeps the static guidance: snake_case, the three gates, truncation", () => {
    quiet();
    const text = buildInstructions(selectTools(makeEnvConfig()));
    expect(text).toContain("Every tool input is snake_case");
    expect(text).toContain("camelCase arguments are rejected");
    expect(text).toContain("READ_ONLY");
    expect(text).toContain("ENABLED_TOOLS");
    expect(text).toContain("MAX_RESPONSE_CHARS");
    expect(text).toContain("truncated:true");
    expect(text).toContain("All three gates compose.");
  });

  it("keeps the parenthetical hints, and only for tools that are in", () => {
    quiet();
    const all = buildInstructions(selectTools(makeEnvConfig()));
    expect(all).toContain("`ping` (health)");
    expect(all).toContain("`weeek_get_me` (current account)");
    expect(all).toContain(
      "`weeek_list_tasks` (paginated via offset/per_page + hasMore)",
    );

    const one = buildInstructions(
      selectTools(makeEnvConfig({ enabledTools: ["ping"] })),
    );
    expect(one).toContain("`ping` (health)");
    expect(one).not.toContain("current account");
  });

  // INVARIANT-14's second assertion, enforced at the source rather than only
  // on the wire: the prose may not name a tool the gate did not select. The
  // trap is the description-clipping clause, which used to name
  // `weeek_get_task` / `weeek_get_project` unconditionally — under a narrow
  // ENABLED_TOOLS that is two identifiers for tools the client cannot call.
  it("never names an unselected tool — including in the clipping clause", () => {
    quiet();
    const selected = selectTools(
      makeEnvConfig({ enabledTools: ["ping", "weeek_list_tags"] }),
    );
    const text = buildInstructions(selected);
    expect(toolTokens(text)).toEqual(new Set(["ping", "weeek_list_tags"]));
    expect(text).not.toContain("may clip description");
  });

  it("emits the clipping clause naming only the detail tools that are in", () => {
    quiet();
    const text = buildInstructions(
      selectTools(makeEnvConfig({ enabledTools: ["weeek_get_task"] })),
    );
    expect(text).toContain("weeek_get_task may clip description");
    expect(text).not.toContain("weeek_get_project");
  });

  // Unreachable in production — `selectTools` throws on an empty selection
  // before this can be called — but pinned because the predicate that decides
  // the read-only claim is `writes.length === 0`, and an empty array satisfies
  // it vacuously. If the claim were ever emitted for a surface of nothing it
  // would be a true statement about a server with no tools, which is not the
  // reassurance it looks like. The assertion here is that the degenerate input
  // is handled deliberately, not that it can occur.
  it("an empty selection does not assert read-only about nothing", () => {
    const text = buildInstructions([]);
    expect(text).not.toContain("Read-only MCP server");
    expect(text).toContain("no tools are registered");
    expect(text).not.toContain("Available tools:");
    expect(toolTokens(text)).toEqual(new Set());
  });

  it("a single write tool alone still drops the read-only claim (toe-dip combo)", () => {
    quiet();
    const selected = selectTools(
      makeEnvConfig({
        readOnly: false,
        enabledTools: ["weeek_complete_task"],
      }),
    );
    const text = buildInstructions(selected);
    expect(text).not.toContain("Read-only MCP server");
    expect(text).toContain("1 of the tools below");
    expect(toolTokens(text)).toEqual(new Set(["weeek_complete_task"]));
  });

  it("READ_ONLY=false with a read-only allowlist is still described as read-only", () => {
    // The claim tracks the selection, not the env flag: this server cannot
    // write, and saying otherwise would make the agent needlessly cautious.
    quiet();
    const selected = selectTools(
      makeEnvConfig({ readOnly: false, enabledTools: ["ping", "weeek_get_me"] }),
    );
    const text = buildInstructions(selected);
    expect(text).toContain("Read-only MCP server for Weeek.");
  });

  it("a hand-built selection is honoured verbatim (no hidden reliance on the manifest)", () => {
    const text = buildInstructions(sel(["weeek_list_tags", "ping"]));
    expect(text).toContain("Available tools: `weeek_list_tags`, `ping` (health).");
  });
});
