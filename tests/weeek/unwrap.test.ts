import { describe, it, expect } from "vitest";
import {
  parseWeeekAck,
  parseWeeekResponse,
  redactUrl,
} from "../../src/weeek/unwrap.js";
import { WeeekError, type WeeekErrorCode } from "../../src/weeek/types.js";

describe("parseWeeekResponse", () => {
  it("returns the inner resource on a 2xx success envelope", () => {
    const out = parseWeeekResponse<{ id: number }>(
      200,
      { success: true, user: { id: 1 } },
      "user",
    );
    expect(out).toEqual({ id: 1 });
  });

  it("maps 401 to weeek_unauthorized", () => {
    let err: unknown;
    try {
      parseWeeekResponse(401, {}, "user");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WeeekError);
    const we = err as WeeekError;
    expect(we.code).toBe("weeek_unauthorized");
    expect(we.status).toBe(401);
    expect(we.message).toBe("weeek http 401");
  });

  it.each<[number, WeeekErrorCode]>([
    [400, "weeek_validation_error"],
    [403, "weeek_forbidden"],
    [404, "weeek_not_found"],
    // I8 (#42): 422 is a REQUEST-validation rejection, not upstream drift.
    // Weeek uses it for per-field validation (bug #28 observed
    // `{"completed":["The completed field must be true or false."]}`), so it
    // must tell the agent to fix its arguments — not to file a drift bug.
    [422, "weeek_validation_error"],
    [429, "weeek_rate_limited"],
    [500, "weeek_server_error"],
    [503, "weeek_server_error"],
  ])("maps status %i to %s", (status, code) => {
    let err: unknown;
    try {
      parseWeeekResponse(status, {}, "user");
    } catch (e) {
      err = e;
    }
    const we = err as WeeekError;
    expect(we).toBeInstanceOf(WeeekError);
    expect(we.code).toBe(code);
    expect(we.status).toBe(status);
  });

  it("a 422 validation body never reaches WeeekError.message (INVARIANT-2)", () => {
    let err: unknown;
    try {
      parseWeeekResponse(
        422,
        {
          success: false,
          message: "The given data was invalid.",
          errors: { title: ["leaky-submitted-field-value"] },
        },
        "task",
      );
    } catch (e) {
      err = e;
    }
    const we = err as WeeekError;
    expect(we.code).toBe("weeek_validation_error");
    expect(we.message).toBe("weeek http 422");
    expect(we.message).not.toContain("leaky-submitted-field-value");
  });

  it("treats non-standard 4xx as weeek_invalid_response", () => {
    let err: unknown;
    try {
      parseWeeekResponse(418, {}, "user");
    } catch (e) {
      err = e;
    }
    const we = err as WeeekError;
    expect(we.code).toBe("weeek_invalid_response");
    expect(we.status).toBe(418);
  });

  it("rejects body=null with weeek_invalid_response", () => {
    let err: unknown;
    try {
      parseWeeekResponse(200, null, "user");
    } catch (e) {
      err = e;
    }
    const we = err as WeeekError;
    expect(we.code).toBe("weeek_invalid_response");
    expect(we.message).toBe("weeek response was not a JSON object");
  });

  it("rejects a non-object body (string)", () => {
    let err: unknown;
    try {
      parseWeeekResponse(200, "ok", "user");
    } catch (e) {
      err = e;
    }
    const we = err as WeeekError;
    expect(we.code).toBe("weeek_invalid_response");
    expect(we.message).toBe("weeek response was not a JSON object");
  });

  it("rejects success=false with the documented message", () => {
    let err: unknown;
    try {
      parseWeeekResponse(200, { success: false, user: {} }, "user");
    } catch (e) {
      err = e;
    }
    const we = err as WeeekError;
    expect(we.code).toBe("weeek_invalid_response");
    expect(we.message).toBe("weeek response missing success=true envelope");
  });

  it("rejects responses missing the envelope key", () => {
    let err: unknown;
    try {
      parseWeeekResponse(200, { success: true }, "user");
    } catch (e) {
      err = e;
    }
    const we = err as WeeekError;
    expect(we.code).toBe("weeek_invalid_response");
    expect(we.message).toContain("missing key 'user'");
  });

  it("rejects responses where the inner key is null", () => {
    let err: unknown;
    try {
      parseWeeekResponse(200, { success: true, user: null }, "user");
    } catch (e) {
      err = e;
    }
    const we = err as WeeekError;
    expect(we.code).toBe("weeek_invalid_response");
    expect(we.message).toContain("missing key 'user'");
  });

  it("rejects responses where the inner key is a non-object", () => {
    let err: unknown;
    try {
      parseWeeekResponse(200, { success: true, user: "alice" }, "user");
    } catch (e) {
      err = e;
    }
    const we = err as WeeekError;
    expect(we.code).toBe("weeek_invalid_response");
    expect(we.message).toContain("missing key 'user'");
  });
});

// I8 (#43) — the write routes answer with the envelope alone, so the ack
// parser accepts a body carrying no resource key at all, and maps the same
// statuses to the same codes as its resource-bearing sibling.
describe("parseWeeekAck", () => {
  it("accepts a bare {success:true} with no resource key", () => {
    expect(() => {
      parseWeeekAck(200, { success: true });
    }).not.toThrow();
  });

  it.each<[number, WeeekErrorCode]>([
    [404, "weeek_not_found"],
    [422, "weeek_validation_error"],
    [500, "weeek_server_error"],
  ])("maps HTTP %i to %s", (status, code) => {
    let err: unknown;
    try {
      parseWeeekAck(status, { success: false });
    } catch (e) {
      err = e;
    }
    expect((err as WeeekError).code).toBe(code);
  });

  it("rejects a 200 that is not a success envelope (never a silent no-op)", () => {
    let err: unknown;
    try {
      parseWeeekAck(200, { success: false });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WeeekError);
    expect((err as WeeekError).code).toBe("weeek_invalid_response");
  });

  it("rejects a non-object 200 body", () => {
    expect(() => {
      parseWeeekAck(200, "ok");
    }).toThrow(WeeekError);
  });
});

describe("redactUrl", () => {
  it.each([
    ["https://u:p@host/x", "https://host/x"],
    ["https://host/x", "https://host/x"],
    ["not-a-url", "[invalid-url]"],
    [
      "https://host/path?q=v#hash",
      "https://host/path?q=v#hash",
    ],
  ])("redactUrl(%s)", (input, expected) => {
    expect(redactUrl(input)).toBe(expected);
  });
});
