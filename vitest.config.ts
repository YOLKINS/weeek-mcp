import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Server-side code; no DOM.
    environment: "node",
    // Tests live in `tests/` (separate from `src/` so they stay outside
    // `tsconfig.json`'s `rootDir:"src"` and the ESLint `files:["src/**"]`
    // scope). See I6a plan §4.
    include: ["tests/**/*.test.ts"],
    // Live-integration tests under `tests/integration/` hit the real Weeek
    // API; they are token-gated (`WEEEK_INTEGRATION_TOKEN`) and run via
    // `npm run test:integration` only — never as part of the default
    // `npm test`. See `.github/workflows/live-smoke.yml`.
    exclude: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "tests/integration/**",
    ],
    // No `globals: true` — every test file imports from "vitest" explicitly.
    // clearMocks resets `.mock.calls` between it-blocks; restoreMocks brings
    // back originals replaced by `vi.spyOn(...)`. Both are critical for
    // `process.stderr.write` spies in the logger tests not leaking across files.
    clearMocks: true,
    restoreMocks: true,
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      // I6b expanded the test surface to handlers, client, and endpoints, so
      // the exclude shrinks to two genuinely non-pure modules:
      //   - src/index.ts: stdio bootstrap (signal hooks, server.connect).
      //     Verified via docs/smoke.md, not unit tests.
      //   - src/weeek/endpoints.ts: barrel re-export. Coverage is measured on
      //     each underlying endpoints/<resource>.ts module instead.
      // src/server/context.ts is type-only; v8 reports 0/0 for it which is
      // harmless under per-file thresholds (no statements to fail).
      exclude: [
        "src/index.ts",
        "src/weeek/endpoints.ts",
        "src/server/context.ts",
      ],
      // Ratchet floor (I6b §2.6): each number is 1-2 p.p. below the current
      // observed minimum within the matched glob. Goal is a regression
      // detector, not an aspirational target — a real drop trips the gate;
      // unrelated refactors stay green. Logger.ts and env.ts retain
      // pre-I6b coverage and their gaps fold into the global floor.
      //
      // I9 (#56): every number below survived the Vitest 3→4 migration
      // untouched, and that is the point — the `thresholds` shape did not
      // change in v4, so a floor moving would have been a decision, not a
      // migration artefact. What DID change is the measurement: v4's v8
      // provider remaps coverage through the AST instead of byte ranges, with
      // no opt-out, so statements are counted as statements (668, not 2651)
      // and a callback that never ran no longer scores as covered because the
      // line declaring it did. Two floors went red under the new counting —
      // `client.ts` functions and the global statements floor via `logger.ts`
      // — and both were genuinely uncovered code: the client's abort timer
      // callback and `logger.debug` / `logger.error`. They were answered with
      // tests, not with lower numbers.
      thresholds: {
        perFile: true,
        "src/weeek/client.ts": {
          lines: 95,
          branches: 95,
          functions: 100,
          statements: 95,
        },
        "src/weeek/endpoints/**": {
          lines: 95,
          branches: 88,
          functions: 100,
          statements: 95,
        },
        // I6.5-ux: pure mapper from `WeeekErrorCode` → English self-correction
        // sentence. Same shape as `endpoints/**`; the 88 branches floor leaves
        // room for the exhaustive-switch `default` branch.
        "src/weeek/humanMessage.ts": {
          lines: 95,
          branches: 88,
          functions: 100,
          statements: 95,
        },
        "src/tools/**/*.tool.ts": {
          lines: 95,
          branches: 95,
          functions: 100,
          statements: 95,
        },
        // I8 seal (#50): the write tools are covered by the glob above, but
        // the modules they were factored INTO are not — `*.tool.ts` does not
        // match an `_`-prefixed shared module. This glob picks up all three
        // that exist: `tasks/_task-detail-output.ts` and
        // `tasks/_write-tool-error.ts` (the shared task-detail output shape
        // and the one write-error leg, used by all five write tools, so a gap
        // in either is a gap in five tools at once) and `_response-limits.ts`,
        // which every gated tool routes its payload through. All three were
        // sitting under the global 90/78/55 floor; all three are at 100%, and
        // they now carry the same numbers the tools do.
        "src/tools/**/_*.ts": {
          lines: 95,
          branches: 95,
          functions: 100,
          statements: 95,
        },
        // Global safety net (registry, env, logger, types,
        // unwrap). The branches/functions floors absorb logger.ts's pre-I6b
        // gap; raise here when a logger test increment lands.
        lines: 90,
        branches: 78,
        functions: 55,
        statements: 90,
      },
    },
  },
});
