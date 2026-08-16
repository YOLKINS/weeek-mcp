import type { MockInstance } from "vitest";
import type { logger } from "../../src/logging/logger.js";

// The type of a `vi.spyOn(logger, "warn" | "info")` handle.
//
// Test files used to spell this `ReturnType<typeof vi.spyOn>`, which worked
// only by accident: `vi.spyOn` is generic, so `ReturnType` resolved its type
// parameters to their constraints and the resulting `mock.calls` was loose
// enough to index freely. Vitest 4 tightened that resolution and every
// `.mock.calls.filter((c) => ...)` in the suite became an implicit-`any`
// parameter error under `tsconfig.test.json` (#56).
//
// Naming the instrumented function instead is both what the tightened types
// want and more honest: `mock.calls` is now typed `[string,
// Record<string, unknown>?][]`, so a call site that reads `c[1]` gets the ctx
// object's real type rather than `any`. `logger.warn` and `logger.info` share
// a signature, hence one alias for both.
export type LoggerMethodSpy = MockInstance<typeof logger.warn>;
