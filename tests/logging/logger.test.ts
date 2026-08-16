import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import { logger } from "../../src/logging/logger.js";

interface Spy {
  mock: { calls: unknown[][] };
}

function lastPayload(spy: Spy): Record<string, unknown> {
  const call = spy.mock.calls[0];
  if (!call) throw new Error("expected at least one call to stderr.write");
  const raw = call[0] as string;
  return JSON.parse(raw.trimEnd()) as Record<string, unknown>;
}

describe("logger", () => {
  let stderrSpy: MockInstance<typeof process.stderr.write>;
  let stdoutSpy: MockInstance<typeof process.stdout.write>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
  });

  it("writes to stderr only — never stdout", () => {
    logger.info("x");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("emits a payload with t, level, msg + ctx merged in, ending with \\n", () => {
    logger.info("hello", { foo: 1 });
    const raw = stderrSpy.mock.calls[0]?.[0] as string;
    expect(raw.endsWith("\n")).toBe(true);
    const payload = JSON.parse(raw.trimEnd()) as Record<string, unknown>;
    expect(payload).toMatchObject({ level: "info", msg: "hello", foo: 1 });
    expect(payload["t"]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it.each([
    "accessToken",
    "weeek_access_token",
    "authorization",
    "password",
    "secret",
    "apikey",
    "api_key",
    "token",
  ])("redacts string value under sensitive key %s", (key) => {
    logger.info("m", { [key]: "supersecretvalue" });
    const payload = lastPayload(stderrSpy);
    expect(payload[key]).toBe("[REDACTED]");
  });

  it("does not redact non-string values under a sensitive key", () => {
    logger.info("m", { accessTokenPresent: true });
    const payload = lastPayload(stderrSpy);
    expect(payload["accessTokenPresent"]).toBe(true);
  });

  it("does not redact empty strings", () => {
    logger.info("m", { token: "" });
    const payload = lastPayload(stderrSpy);
    expect(payload["token"]).toBe("");
  });

  it("redacts nested string values recursively", () => {
    logger.info("m", { outer: { authorization: "x", okay: 1 } });
    const payload = lastPayload(stderrSpy);
    const outer = payload["outer"] as Record<string, unknown>;
    expect(outer["authorization"]).toBe("[REDACTED]");
    expect(outer["okay"]).toBe(1);
  });

  it("redacts inside arrays of objects", () => {
    logger.info("m", { arr: [{ token: "a" }, { token: "b" }] });
    const payload = lastPayload(stderrSpy);
    const arr = payload["arr"] as Array<Record<string, unknown>>;
    expect(arr[0]?.["token"]).toBe("[REDACTED]");
    expect(arr[1]?.["token"]).toBe("[REDACTED]");
  });

  it("breaks circular references with [Circular]", () => {
    interface Cycle {
      self?: Cycle;
    }
    const a: Cycle = {};
    a.self = a;
    expect(() => logger.info("m", { a: a as unknown as Record<string, unknown> })).not.toThrow();
    const payload = lastPayload(stderrSpy);
    const aOut = payload["a"] as { self: unknown };
    expect(aOut.self).toBe("[Circular]");
  });

  it("caps recursion at 5 levels with [MaxDepth]", () => {
    const deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: "deep" } } } } } } };
    expect(() => logger.info("m", deep)).not.toThrow();
    const payload = lastPayload(stderrSpy);
    const l1 = payload["l1"] as Record<string, unknown>;
    const l2 = l1["l2"] as Record<string, unknown>;
    const l3 = l2["l3"] as Record<string, unknown>;
    const l4 = l3["l4"] as Record<string, unknown>;
    const l5 = l4["l5"] as Record<string, unknown>;
    expect(l5["l6"]).toBe("[MaxDepth]");
  });

  // Every case above drives `logger.info`. `debug` and `error` had no test at
  // all — the module's own level fan-out was unexercised, and INVARIANT-1
  // ("stdout is the JSON-RPC channel") is a property of *every* level, not of
  // the one the tests happened to use. Vitest 4's AST-aware coverage is what
  // made that visible (#56); v3 scored the four arrow functions in the
  // exported object as covered because the object literal was evaluated.
  it.each(["info", "warn", "error"] as const)(
    "logger.%s writes one line to stderr and nothing to stdout",
    (level) => {
      logger[level]("m", { foo: 1 });
      expect(stdoutSpy).not.toHaveBeenCalled();
      const payload = lastPayload(stderrSpy);
      expect(payload).toMatchObject({ level, msg: "m", foo: 1 });
    },
  );

  it("logger.debug is silent at the default level", () => {
    logger.debug("m");
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});

// `currentLevel` is read from the environment once, at module load, so these
// cases cannot share the module instance with the suite above: each resets the
// registry and re-imports with LOG_LEVEL already set.
describe("logger — LOG_LEVEL at module load", () => {
  let stderrSpy: MockInstance<typeof process.stderr.write>;
  const original = process.env["LOG_LEVEL"];

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    vi.resetModules();
  });

  afterEach(() => {
    if (original === undefined) delete process.env["LOG_LEVEL"];
    else process.env["LOG_LEVEL"] = original;
  });

  async function freshLogger(level: string): Promise<typeof logger> {
    process.env["LOG_LEVEL"] = level;
    const mod = (await import("../../src/logging/logger.js")) as {
      logger: typeof logger;
    };
    return mod.logger;
  }

  it("drops a message below the configured level", async () => {
    const fresh = await freshLogger("warn");
    fresh.info("quiet");
    expect(stderrSpy).not.toHaveBeenCalled();
    fresh.warn("loud");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it("an unrecognised LOG_LEVEL falls back to info rather than throwing", async () => {
    const fresh = await freshLogger("not-a-level");
    fresh.debug("below info");
    expect(stderrSpy).not.toHaveBeenCalled();
    fresh.info("at info");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });
});
