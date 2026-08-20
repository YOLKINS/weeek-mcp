import { describe, it, expect, beforeAll } from "vitest";
import { DIST_INDEX, ensureBuilt, spawnServer } from "../helpers/distServer.js";
import { READ_TOOLS, ALL_TOOLS } from "../helpers/toolNames.js";

// The I8 seal (#50) — the tool surface pinned where a client actually sees
// it: the bytes coming back from `tools/list` over stdio, out of the built
// `dist/index.js`.
//
// Every other count assertion in the suite reads the registry in-process
// (`tests/tools/registry.test.ts`, `tests/invariants/mcp.test.ts`) and so
// measures our own list of registrations. This one measures the wire, which
// is the only place the SDK's own filtering, serialization and zod → JSON
// Schema conversion are in the loop. It is also the only place the third
// acceptance number can be taken honestly: the size of the whole payload, not
// just the prose portion the in-process budget bounds.
//
// Two numbers, pinned literally rather than structurally now that the
// increment is closed:
//
//   READ_ONLY=true  → exactly 10 tools (the default install's surface)
//   READ_ONLY=false → exactly 15 tools (10 reads + the 5 I8 writes)

interface ToolsListEntry {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

interface JsonRpcResponse {
  id?: number;
  result?: { tools?: ToolsListEntry[]; instructions?: string };
}

const INITIALIZE =
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":' +
  '{"protocolVersion":"2025-06-18","capabilities":{},' +
  '"clientInfo":{"name":"seal","version":"0"}}}\n';
const INITIALIZED = '{"jsonrpc":"2.0","method":"notifications/initialized"}\n';
const TOOLS_LIST = '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n';

interface ListResult {
  /** The `tools` array from the id=2 response. */
  tools: ToolsListEntry[];
  /** Length of the raw NDJSON line the client received — the real payload. */
  rawChars: number;
  /**
   * `result.instructions` from the id=1 response. INVARIANT-14 checks it
   * against `tools`; before 1.0.1 this exchange threw the initialize reply
   * away, which is exactly how the prose drifted a whole increment behind the
   * surface without a single test noticing.
   */
  instructions: string;
}

/**
 * Drive a real `initialize` → `notifications/initialized` → `tools/list`
 * exchange against a spawned server and return BOTH responses: the id=1
 * `instructions` and the id=2 tool list, plus the length of the line the
 * latter arrived on.
 */
async function toolsList(env: Record<string, string>): Promise<ListResult> {
  const proc = spawnServer(env);
  let stdout = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  proc.stdin.write(INITIALIZE + INITIALIZED + TOOLS_LIST);

  // Poll rather than sleep a fixed budget: the exchange is three lines and
  // usually settles in well under 100 ms, but a loaded CI runner can be slow
  // to start Node at all.
  //
  // `slice(0, -1)` drops the trailing fragment after the last newline, so only
  // COMPLETED lines are considered. The 15-tool response is ~37 KB and arrives
  // in several chunks, so a substring match on the raw buffer would happily
  // hand a half-arrived line to `JSON.parse`. Responses are picked apart by
  // parsing each finished line and switching on `id` rather than by matching
  // `"id":1` / `"id":2` as text — the ids are the protocol's, not a substring
  // we hope stays unambiguous inside 37 KB of JSON Schema.
  const deadline = Date.now() + 8_000;
  let init: JsonRpcResponse | undefined;
  let list: JsonRpcResponse | undefined;
  let listLine: string | undefined;
  while (Date.now() < deadline) {
    for (const l of stdout.split("\n").slice(0, -1)) {
      let parsed: JsonRpcResponse;
      try {
        parsed = JSON.parse(l) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (parsed.id === 1) init = parsed;
      if (parsed.id === 2) {
        list = parsed;
        listLine = l;
      }
    }
    if (init && list) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  proc.kill("SIGTERM");
  await new Promise<void>((resolve) => proc.on("exit", () => resolve()));

  expect(
    list,
    `no tools/list response from ${DIST_INDEX}; stdout was: ${stdout.slice(0, 400)}`,
  ).toBeDefined();
  expect(
    init,
    `no initialize response from ${DIST_INDEX}; stdout was: ${stdout.slice(0, 400)}`,
  ).toBeDefined();
  return {
    tools: list?.result?.tools ?? [],
    rawChars: (listLine ?? "").length,
    instructions: init?.result?.instructions ?? "",
  };
}

// One exchange per configuration, shared by every assertion about it. Each
// spawn is ~100 ms of real process startup, and re-running one to re-read a
// number the previous test already had buys nothing.
const listed = new Map<string, Promise<ListResult>>();
function listOnce(readOnly: "true" | "false"): Promise<ListResult> {
  const cached = listed.get(readOnly);
  if (cached) return cached;
  const pending = toolsList({ READ_ONLY: readOnly });
  listed.set(readOnly, pending);
  return pending;
}

describe("I8 seal — the tool surface on the wire", () => {
  beforeAll(() => {
    ensureBuilt();
  });

  it(
    "READ_ONLY=true advertises exactly 10 tools — the read set, no writes",
    async () => {
      const { tools } = await listOnce("true");
      expect(tools).toHaveLength(10);
      expect(tools.map((t) => t.name)).toEqual([...READ_TOOLS]);
    },
    20_000,
  );

  it(
    "READ_ONLY=false advertises exactly 15 tools — the read set plus the five writes",
    async () => {
      const { tools } = await listOnce("false");
      expect(tools).toHaveLength(15);
      expect(tools.map((t) => t.name)).toEqual([...ALL_TOOLS]);
    },
    20_000,
  );

  // The B13 measurement #47 deferred to this ticket, and its result — which
  // corrects the premise B13 was written on.
  //
  // The in-process budget in `tests/invariants/mcp.test.ts` bounds the PROSE
  // only (title + description + annotations), because it has no JSON Schema
  // to measure: the zod → JSON Schema conversion is the SDK's and happens
  // past the registry. Measured here, on the wire, the split at 15 tools is
  // prose ~9 600 chars against schemas ~27 000 — the prose budget bounds a
  // quarter of the payload, and the part it does not bound is the part that
  // grows fastest per tool.
  //
  // The ~25 000 figure B13 carries is a *token* budget (the per-MCP-message
  // cap clients such as Claude Code apply, `MAX_MCP_OUTPUT_TOKENS`), and B13
  // spent it as though it were chars. At roughly 4 chars per token the full
  // write surface is ~9 400 tokens, so the real headroom is comfortable even
  // though the char number is past 25 000. Both facts are pinned below rather
  // than either being asserted alone: the default install is held to the
  // conservative char reading it genuinely meets, and the write surface is
  // held to a ratchet just above today's observation, so growth is visible
  // without a fictitious cliff.
  it(
    "the default surface stays inside the conservative 25k-char reading of the budget",
    async () => {
      const { rawChars, tools } = await listOnce("true");
      expect(tools).toHaveLength(10);
      process.stderr.write(
        `[seal] tools/list payload at 10 tools: ${rawChars} chars\n`,
      );
      expect(rawChars).toBeLessThan(25_000);
    },
    20_000,
  );

  it(
    "the write surface stays under its growth ratchet (~6% over today's payload)",
    async () => {
      // Observed 2026-07-23 at the sealed 15-tool surface: 37 565 chars.
      // 37 969 after I9 (#63) added the two silent-drop limits to
      // `weeek_update_task` and `weeek_create_task` — +404 chars of prose, no
      // schema movement, which is what an information-only change should look
      // like from here.
      // A ratchet, not a cliff: it catches a tool arriving with a runaway
      // schema, and a deliberate addition moves the number in the diff.
      const { rawChars, tools } = await listOnce("false");
      expect(tools).toHaveLength(15);
      process.stderr.write(
        `[seal] tools/list payload at 15 tools: ${rawChars} chars\n`,
      );
      expect(rawChars).toBeLessThan(40_000);
    },
    20_000,
  );
});

// INVARIANT-14 — the `instructions` prose matches the advertised surface.
//
// The server's `instructions` is the first thing a client reads and the only
// natural-language account of what this server is. Through 1.0.0 it was a hand
// written literal in `src/index.ts`, and it drifted: it opened "Read-only MCP
// server for Weeek", listed the ten read tools, and closed with "Mutating
// tools land in I8+" — while I8 had shipped and `READ_ONLY=false` was serving
// five write tools it never mentioned. `tools/list` was correct the whole
// time, and the field is advisory by spec, so nothing was broken in the
// protocol sense. It was simply false, and nothing in the suite could tell.
//
// Both sides are compared as TOKEN SETS, deliberately, never with
// `includes()`:
//
//   "weeek_list_tasks_extra".includes("weeek_list_tasks") === true
//
// so a substring check would call a renamed-away tool "still mentioned". And
// `\b` does NOT rescue it — `_` is a word character, so there is no boundary
// between `tasks` and `_extra` for `\b` to find. What rescues it is the GREEDY
// `[a-z_]+`, which swallows the whole identifier and yields the token
// `weeek_list_tasks_extra`, which then simply fails set equality. Anyone
// "tidying" this into a lazy `[a-z_]+?` silently re-opens the hole.
const TOOL_TOKEN = /\b(ping|weeek_[a-z_]+)\b/g;

function toolTokens(text: string): Set<string> {
  return new Set(text.match(TOOL_TOKEN) ?? []);
}

describe("INVARIANT-14 — instructions match the advertised surface", () => {
  beforeAll(() => {
    ensureBuilt();
  });

  it.each<["true" | "false", number]>([
    ["true", 10],
    ["false", 15],
  ])(
    "READ_ONLY=%s: every advertised tool is named in instructions, and vice versa",
    async (readOnly, expectedCount) => {
      const { tools, instructions } = await listOnce(readOnly);
      expect(tools).toHaveLength(expectedCount);
      expect(instructions.length).toBeGreaterThan(0);

      // Run the same tokenizer over the wire-side names too, rather than using
      // them raw. It costs nothing and it means a future tool whose name the
      // pattern cannot express (camelCase, a digit, a leading underscore)
      // fails HERE — visibly, in the guard — instead of quietly dropping out
      // of the set on one side and passing.
      const advertised = new Set(tools.map((t) => t.name));
      const advertisedTokens = toolTokens(tools.map((t) => t.name).join(" "));
      expect(
        advertisedTokens,
        "a tool name that the INVARIANT-14 tokenizer cannot represent — widen the pattern in the same PR",
      ).toEqual(advertised);

      const named = toolTokens(instructions);

      // (1) nothing advertised goes unmentioned.
      expect([...advertised].filter((n) => !named.has(n))).toEqual([]);
      // (2) nothing mentioned goes unadvertised. This is the assertion that
      // constrains the prose: a sentence like "set READ_ONLY=false to get
      // `weeek_create_task`" would fail under READ_ONLY=true, because that
      // name is not on this server's surface.
      expect([...named].filter((n) => !advertised.has(n))).toEqual([]);
    },
    20_000,
  );

  it.each<["true" | "false"]>([["true"], ["false"]])(
    "READ_ONLY=%s: the read-only claim agrees with the annotations on the wire",
    async (readOnly) => {
      const { tools, instructions } = await listOnce(readOnly);
      const writes = tools.filter(
        (t) => t.annotations?.["readOnlyHint"] === false,
      );

      // (3) The claim is derived from the SURFACE, not from the env flag —
      // `READ_ONLY=false` plus a read-only allowlist is a read-only server,
      // and the prose should say so. So the assertion keys off the annotations
      // the client actually received.
      if (writes.length === 0) {
        expect(instructions).toContain("Read-only MCP server for Weeek.");
        expect(instructions).not.toContain("MODIFY Weeek data");
      } else {
        expect(instructions).not.toContain("Read-only MCP server");
        expect(instructions).toContain("MODIFY Weeek data");
        expect(instructions).toContain(
          `${String(writes.length)} of the tools below`,
        );
      }
    },
    20_000,
  );

  it(
    "the 1.0.0 prose is gone from the wire: no 'Mutating tools land in I8+'",
    async () => {
      for (const readOnly of ["true", "false"] as const) {
        const { instructions } = await listOnce(readOnly);
        expect(instructions).not.toContain("Mutating tools land in I8+");
      }
    },
    20_000,
  );
});
