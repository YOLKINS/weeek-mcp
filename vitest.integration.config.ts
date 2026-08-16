import { defineConfig } from "vitest/config";

// Dedicated runner for the token-gated live-integration suite under
// `tests/integration/`. The default `vitest.config.ts` deliberately
// *excludes* that directory (so `npm test` never hits the network); a
// positional filter cannot override that exclude — vitest merges CLI and
// config excludes rather than replacing them — so the live suite needs its
// own config whose `include` targets the directory and whose `exclude` does
// not remove it.
//
// Run via `npm run test:integration`. Token-gated: with no
// `WEEEK_INTEGRATION_TOKEN` the single suite calls `describe.skipIf(...)`,
// so the file is collected, every it-block is skipped, and the run exits 0
// (green) — the common local case. With the token set (only the
// `live-smoke.yml` tag-run) the probes fire against the real Weeek API.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**", "coverage/**"],
    // Mirror the default config's mock hygiene so behaviour is identical to
    // the mock suite. (`mergeConfig` is deliberately not used: it would
    // concatenate the base config's `exclude: ["tests/integration/**"]` back
    // in, re-excluding the very directory this config exists to include.)
    clearMocks: true,
    restoreMocks: true,
    reporters: ["default"],
  },
});
