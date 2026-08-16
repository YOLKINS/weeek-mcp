import { beforeEach, vi } from "vitest";
import { resetShapeWarnDedup } from "../../src/weeek/shape.js";
import { logger } from "../../src/logging/logger.js";

// Tolerant shaping (I7.5) emits a de-duplicated `logger.warn` to stderr each
// time a field or container degrades. Endpoint tests that drive drift want that
// warn silenced (so it does not clutter test output) and the per-process dedup
// `Set` reset between cases (so one file's drift counts never leak into the
// next test). Registers a `beforeEach` in the calling suite; call it once at the
// top of a `describe`.
export function silenceShapeWarn(): void {
  beforeEach(() => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    resetShapeWarnDedup();
  });
}
