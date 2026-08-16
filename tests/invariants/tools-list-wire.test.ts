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
  result?: { tools?: ToolsListEntry[] };
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
}

/**
 * Drive a real `initialize` → `notifications/initialized` → `tools/list`
 * exchange against a spawned server and return the id=2 result plus the
 * length of the line it arrived on.
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
  // in several chunks; `"id":2` and `"tools"` both appear in its first few
  // bytes, so matching on the raw buffer would happily hand a half-arrived
  // line to `JSON.parse`.
  const deadline = Date.now() + 8_000;
  let line: string | undefined;
  while (Date.now() < deadline) {
    line = stdout
      .split("\n")
      .slice(0, -1)
      .find((l) => l.includes('"id":2') && l.includes('"tools"'));
    if (line) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  proc.kill("SIGTERM");
  await new Promise<void>((resolve) => proc.on("exit", () => resolve()));

  expect(
    line,
    `no tools/list response from ${DIST_INDEX}; stdout was: ${stdout.slice(0, 400)}`,
  ).toBeDefined();
  const parsed = JSON.parse(line as string) as JsonRpcResponse;
  return { tools: parsed.result?.tools ?? [], rawChars: (line as string).length };
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
