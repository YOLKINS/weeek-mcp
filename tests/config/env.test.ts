import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/config/env.js";
import { logger } from "../../src/logging/logger.js";
import type { LoggerMethodSpy } from "../helpers/spies.js";

const SRC_DIR = fileURLToPath(new URL("../../src/", import.meta.url));

const VALID = "x".repeat(32);

/** The two names 1.0.0 stopped recognising (#54). */
const REMOVED_ALIASES = ["WEEEK_API_TOKEN", "WEEEK_API_BASE_URL"] as const;

const ENV_KEYS = [
  "WEEEK_ACCESS_TOKEN",
  "WEEEK_BASE_URL",
  "WEEEK_TIMEOUT_MS",
  "READ_ONLY",
  "ENABLED_TOOLS",
  "MAX_RESPONSE_CHARS",
  // Removed in 1.0.0 (#54). Still cleared before every case: the loader must
  // ignore them, and a developer with the old names exported in their shell
  // must see the same result as one who never had them.
  ...REMOVED_ALIASES,
] as const;

/** Unset every variable this suite knows about, ambient shell included. */
function clearEnv(): void {
  for (const k of ENV_KEYS) {
    vi.stubEnv(k, undefined);
  }
}

describe("loadConfig", () => {
  beforeEach(clearEnv);
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts the minimal valid env and applies defaults", () => {
    vi.stubEnv("WEEEK_ACCESS_TOKEN", VALID);
    const cfg = loadConfig();
    expect(cfg.accessToken).toBe(VALID);
    expect(cfg.baseUrl).toBe("https://api.weeek.net/public/v1");
    expect(cfg.readOnly).toBe(true);
    expect(cfg.maxResponseChars).toBe(65536);
    expect(cfg.timeoutMs).toBe(30000);
    expect(cfg.enabledTools).toBeUndefined();
  });

  it("rejects the lower-case placeholder token", () => {
    vi.stubEnv("WEEEK_ACCESS_TOKEN", "your-weeek-token-here");
    expect(() => loadConfig()).toThrow(/placeholder/);
  });

  it("rejects the upper-case placeholder token", () => {
    vi.stubEnv("WEEEK_ACCESS_TOKEN", "YOUR_WEEEK_TOKEN_HERE");
    expect(() => loadConfig()).toThrow(/placeholder/);
  });

  it("rejects whitespace inside the token", () => {
    vi.stubEnv("WEEEK_ACCESS_TOKEN", "  abcdefghijklmnopqr");
    expect(() => loadConfig()).toThrow(/whitespace or control/);
  });

  it("rejects tokens shorter than 20 chars", () => {
    vi.stubEnv("WEEEK_ACCESS_TOKEN", "x".repeat(19));
    expect(() => loadConfig()).toThrow(/WEEEK_ACCESS_TOKEN/);
  });

  it("accepts a 20-char token (boundary)", () => {
    vi.stubEnv("WEEEK_ACCESS_TOKEN", "x".repeat(20));
    expect(() => loadConfig()).not.toThrow();
  });

  it("rejects an ftp base URL", () => {
    vi.stubEnv("WEEEK_ACCESS_TOKEN", VALID);
    vi.stubEnv("WEEEK_BASE_URL", "ftp://example.com");
    expect(() => loadConfig()).toThrow(/http or https/);
  });

  it("rejects a base URL with embedded credentials", () => {
    vi.stubEnv("WEEEK_ACCESS_TOKEN", VALID);
    vi.stubEnv("WEEEK_BASE_URL", "https://u:p@api.weeek.net/v1");
    expect(() => loadConfig()).toThrow(/credentials/);
  });

  it("treats READ_ONLY=\"false\" as boolean false (not z.coerce.boolean)", () => {
    vi.stubEnv("WEEEK_ACCESS_TOKEN", VALID);
    vi.stubEnv("READ_ONLY", "false");
    expect(loadConfig().readOnly).toBe(false);
  });

  it("treats READ_ONLY=\"0\" as boolean false", () => {
    vi.stubEnv("WEEEK_ACCESS_TOKEN", VALID);
    vi.stubEnv("READ_ONLY", "0");
    expect(loadConfig().readOnly).toBe(false);
  });

  it("rejects an empty READ_ONLY", () => {
    vi.stubEnv("WEEEK_ACCESS_TOKEN", VALID);
    vi.stubEnv("READ_ONLY", "");
    expect(() => loadConfig()).toThrow(/'true' \| 'false' \| '1' \| '0'/);
  });

  it("rejects unknown READ_ONLY values", () => {
    vi.stubEnv("WEEEK_ACCESS_TOKEN", VALID);
    vi.stubEnv("READ_ONLY", "maybe");
    expect(() => loadConfig()).toThrow(/READ_ONLY/);
  });

  it("rejects ENABLED_TOOLS that resolves to zero entries", () => {
    vi.stubEnv("WEEEK_ACCESS_TOKEN", VALID);
    vi.stubEnv("ENABLED_TOOLS", " , ,  ");
    expect(() => loadConfig()).toThrow(/at least one/);
  });

  it("trims and dedupes ENABLED_TOOLS entries", () => {
    vi.stubEnv("WEEEK_ACCESS_TOKEN", VALID);
    vi.stubEnv("ENABLED_TOOLS", " a, b ,a ");
    const cfg = loadConfig();
    expect(cfg.enabledTools).toEqual(["a", "b"]);
  });

  it.each([
    ["1023", /1024/],
    ["1000001", /1000000/],
    ["abc", /received nan/i],
  ])("rejects MAX_RESPONSE_CHARS=%s", (value, pattern) => {
    vi.stubEnv("WEEEK_ACCESS_TOKEN", VALID);
    vi.stubEnv("MAX_RESPONSE_CHARS", value);
    expect(() => loadConfig()).toThrow(pattern);
  });

  it("rejects WEEEK_TIMEOUT_MS above the cap", () => {
    vi.stubEnv("WEEEK_ACCESS_TOKEN", VALID);
    vi.stubEnv("WEEEK_TIMEOUT_MS", "600001");
    expect(() => loadConfig()).toThrow(/600000/);
  });

  it("formats multi-issue errors with the documented prefix", () => {
    vi.stubEnv("WEEEK_ACCESS_TOKEN", "short");
    vi.stubEnv("WEEEK_BASE_URL", "ftp://example.com");
    let err: unknown;
    try {
      loadConfig();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg.startsWith("invalid env:\n  ")).toBe(true);
    expect(msg).toContain("WEEEK_ACCESS_TOKEN");
    expect(msg).toContain("WEEEK_BASE_URL");
  });

  // The ENV aliases added in I6.5-ux (D2) as a migration path off
  // `weeek-mcp-server` are removed in 1.0.0 (#54) — the version every
  // alias-only boot had been naming in its deprecation warn since.
  //
  // These cases are the *converse* of the ones they replace, and they are
  // deletions rather than skips: a skipped alias test still describes the
  // alias as a feature that is merely off. What must hold now is that the
  // two names are inert — not read, not copied onto the canonical variable,
  // not warned about — so an alias-only operator meets the ordinary
  // required-variable error naming `WEEEK_ACCESS_TOKEN` instead of a server
  // that silently starts against a name nobody documents any more.
  describe("ENV alias removal (I9, #54)", () => {
    let warnSpy: LoggerMethodSpy;

    beforeEach(() => {
      warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

    /** Every warn the loader emitted, message + ctx flattened to one string. */
    function warnText(): string {
      return warnSpy.mock.calls.map((call) => JSON.stringify(call)).join("\n");
    }

    it("WEEEK_API_TOKEN alone no longer starts the server: required-variable error, zero warns", () => {
      vi.stubEnv("WEEEK_API_TOKEN", VALID);
      expect(() => loadConfig()).toThrow(/WEEEK_ACCESS_TOKEN/);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("the alias-only failure message leaks no part of the supplied token", () => {
      vi.stubEnv("WEEEK_API_TOKEN", VALID);
      let err: unknown;
      try {
        loadConfig();
      } catch (e) {
        err = e;
      }
      const msg = (err as Error).message;
      expect(msg).toContain("WEEEK_ACCESS_TOKEN");
      expect(msg).not.toContain(VALID);
      // A prefix check, not just the whole value: a truncated echo would leak
      // just as usefully to whoever reads the operator's terminal scrollback.
      expect(msg).not.toContain("xxxx");
    });

    it("WEEEK_API_BASE_URL is ignored: the canonical default stands, zero warns", () => {
      vi.stubEnv("WEEEK_ACCESS_TOKEN", VALID);
      vi.stubEnv("WEEEK_API_BASE_URL", "https://proxy.example.com/v1");
      expect(loadConfig().baseUrl).toBe("https://api.weeek.net/public/v1");
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("both removed names alongside their canonicals change nothing and warn about nothing", () => {
      vi.stubEnv("WEEEK_ACCESS_TOKEN", VALID);
      vi.stubEnv("WEEEK_BASE_URL", "https://api.weeek.net/public/v1");
      vi.stubEnv("WEEEK_API_TOKEN", "y".repeat(32));
      vi.stubEnv("WEEEK_API_BASE_URL", "https://wrong.example.com/v1");
      const cfg = loadConfig();
      expect(cfg.accessToken).toBe(VALID);
      expect(cfg.baseUrl).toBe("https://api.weeek.net/public/v1");
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it.each(REMOVED_ALIASES)(
      "%s is named in no warn under any env combination",
      (removed) => {
        for (const combo of [
          { [removed]: VALID },
          { WEEEK_ACCESS_TOKEN: VALID, [removed]: VALID },
          { WEEEK_ACCESS_TOKEN: VALID, [removed]: "" },
        ]) {
          warnSpy.mockClear();
          clearEnv();
          for (const [k, v] of Object.entries(combo)) vi.stubEnv(k, v);
          try {
            loadConfig();
          } catch {
            /* the no-canonical combo is expected to throw */
          }
          expect(warnText()).not.toContain(removed);
        }
      },
    );

    // The table was a data structure; a later edit could reinstate it in one
    // line and every behavioural case above would still pass only because the
    // canonical name happens to win. So grep for the *names* — over the whole
    // of `src/`, not just the loader, since a reinstatement that lands in a
    // new module the loader imports is the same regression wearing a hat.
    it.each(REMOVED_ALIASES)("%s appears nowhere under src/", (removed) => {
      const offenders = (readdirSync(SRC_DIR, { recursive: true }) as string[])
        .filter((f) => f.endsWith(".ts"))
        .filter((f) =>
          readFileSync(path.join(SRC_DIR, f), "utf8").includes(removed),
        );
      expect(offenders).toEqual([]);
    });
  });
});
