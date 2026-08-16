import { describe, it, expect, beforeAll } from "vitest";
import { ensureBuilt, spawnServer } from "../helpers/distServer.js";

// INVARIANT-11 (NEW in I7-prep, D5) — stdio cleanliness on startup.
//
// The in-process invariants in `tests/invariants/mcp.test.ts` already
// spy on `process.stdout.write` across every tool's happy + error path.
// What they cannot catch is a regression in the *startup sequence*
// itself — `loadConfig`, `createWeeekClient`, `registerAllTools`,
// `server.connect`, signal-handler wiring — where any stray write to
// stdout would corrupt the JSON-RPC channel for every connected
// client. INVARIANT-11 closes that gap by spawning the actual
// `dist/index.js`, feeding it nothing on stdin, and asserting:
//
//   1. zero bytes written to stdout in a 500 ms window
//   2. the structured "mcp server started" log line appears on stderr
//
// Since I9 (#54) a startup that *refuses* to get that far is covered by
// the same suite, and there (1) still holds while (2) must not: an env
// the loader rejects has to abort non-zero on stderr alone, leaving the
// JSON-RPC channel untouched.
//
// 500 ms is empirically enough for config-load + server.connect (~50 ms
// on a CI runner). Bump to 750 ms in the Findings table if Node 22
// gc-pauses ever flake this.

interface SpawnResult {
  stdoutBytes: number;
  stderrText: string;
  /**
   * Exit status when the server terminated **on its own** inside the window,
   * `null` when it was still up and had to be SIGTERM-ed. A startup that
   * aborts is a legitimate outcome for a bad env (#54), and the two cases have
   * to be distinguishable — `null` here means "survived", not "exited 0".
   */
  selfExitCode: number | null;
}

// Spawn the built binary with a placeholder token, watch stdio for 500 ms,
// then SIGTERM whatever is still running. `env` overrides ride on top of the
// base environment; an `undefined` override removes the variable.
async function spawnAndWatch(
  env: Record<string, string | undefined>,
): Promise<SpawnResult> {
  const proc = spawnServer(env);

  let stdoutBytes = 0;
  let stderrText = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    stderrText += chunk.toString();
  });

  // `close` rather than `exit`: it fires once the child's stdio streams are
  // drained, so an abort message written on the way out is never raced.
  const status: { code: number | null; done: boolean } = {
    code: null,
    done: false,
  };
  const closed = new Promise<void>((resolve) =>
    proc.on("close", (code) => {
      status.code = code;
      status.done = true;
      resolve();
    }),
  );

  // Wait long enough for `loadConfig` + `server.connect` to settle and
  // the "mcp server started" log line to emit — or for a startup that
  // refuses to get that far to fall over.
  await Promise.race([
    closed,
    new Promise<void>((resolve) => setTimeout(resolve, 500)),
  ]);
  const selfExitCode = status.done ? status.code : null;
  if (!status.done) proc.kill("SIGTERM");
  await closed;
  return { stdoutBytes, stderrText, selfExitCode };
}

describe("INVARIANT-11: stdio cleanliness on startup", () => {
  beforeAll(() => {
    // The smoke runs the *built* artifact — `npm test` does not require
    // `npm run build` to have run first, so bootstrap dist/ when missing.
    ensureBuilt();
  });

  it(
    "spawns dist/index.js with a fake token: 0 stdout bytes; stderr contains 'mcp server started'",
    async () => {
      const { stdoutBytes, stderrText } = await spawnAndWatch({
        READ_ONLY: "true",
      });
      expect(stdoutBytes, "INVARIANT-1 + INVARIANT-11: dist/index.js wrote bytes to stdout on startup").toBe(0);
      expect(stderrText).toMatch(/"msg":"mcp server started"/);
    },
    10_000,
  );

  // I8 (#43) — the same guarantee with writes enabled. `READ_ONLY=false` runs
  // a different startup path: extra registrations, and (before any tool call)
  // the gate's own `tool gated by …` logging is skipped rather than emitted.
  // The in-process sweeps cover handler bodies; only a real spawn covers the
  // registration path of a write tool, which is the one that would corrupt
  // every client's JSON-RPC parser if it ever printed a banner to stdout.
  it(
    "spawns with READ_ONLY=false: still 0 stdout bytes with write tools registered",
    async () => {
      const { stdoutBytes, stderrText } = await spawnAndWatch({
        READ_ONLY: "false",
      });
      expect(
        stdoutBytes,
        "INVARIANT-11 (writes enabled): dist/index.js wrote bytes to stdout on startup",
      ).toBe(0);
      expect(stderrText).toMatch(/"msg":"mcp server started"/);
      // The gate logs to stderr only — and nothing about the write tool being
      // hidden, because it is not hidden here.
      expect(stderrText).not.toMatch(/tool gated by READ_ONLY/);
    },
    10_000,
  );

  // The recommended granular rollout (ADR 0004 §1): writes on, allowlist
  // narrowed to the single least-destructive one. Proves the composed gate
  // survives the real config loader, not just the in-process registry test.
  it(
    "spawns with the toe-dip combo (READ_ONLY=false + ENABLED_TOOLS): clean stdout, server up",
    async () => {
      const { stdoutBytes, stderrText } = await spawnAndWatch({
        READ_ONLY: "false",
        ENABLED_TOOLS: "weeek_complete_task",
      });
      expect(stdoutBytes).toBe(0);
      expect(stderrText).toMatch(/"msg":"mcp server started"/);
      // Everything else was gated by the allowlist — including `ping`. The
      // one tool named in the allowlist is the one NOT gated, so it appears
      // in no gate line (each line names the tool it skipped).
      const gated = stderrText
        .split("\n")
        .filter((l) => l.includes("tool gated by"));
      expect(gated.length).toBeGreaterThan(0);
      expect(gated.join("\n")).not.toContain("weeek_complete_task");
    },
    10_000,
  );

  // I9 (#54) — the alias removal edits the very first thing startup does, and
  // the failure branch it opens up is one no previous case had exercised
  // against the real binary: `loadConfig` throwing before `server.connect`.
  // A server that dies during boot must die the same way it lives — with the
  // JSON-RPC channel untouched, because a client reading a half-line of
  // English on stdout cannot even parse the error it is being handed.
  it(
    "spawns with the removed alias only: exits non-zero having written 0 stdout bytes",
    async () => {
      const ALIAS_ONLY = "z".repeat(32);
      const { stdoutBytes, stderrText, selfExitCode } = await spawnAndWatch({
        WEEEK_ACCESS_TOKEN: undefined,
        WEEEK_API_TOKEN: ALIAS_ONLY,
      });
      expect(
        stdoutBytes,
        "INVARIANT-1 + INVARIANT-11: a failed startup wrote bytes to stdout",
      ).toBe(0);
      expect(selfExitCode, "an unsatisfiable env must abort startup").not.toBe(
        null,
      );
      expect(selfExitCode).not.toBe(0);
      // The operator is told which variable to set — the canonical one — and
      // is told nothing about the value they supplied under the dead name.
      expect(stderrText).toContain("WEEEK_ACCESS_TOKEN");
      expect(stderrText).not.toContain(ALIAS_ONLY);
      expect(stderrText).not.toMatch(/env alias/);
      expect(stderrText).not.toMatch(/"msg":"mcp server started"/);
    },
    10_000,
  );
});
