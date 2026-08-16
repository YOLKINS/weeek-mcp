import { describe, it, expect } from "vitest";
import { humanMessage } from "../../src/weeek/humanMessage.js";
import {
  WeeekError,
  WeeekRequestNotSentError,
  type WeeekErrorCode,
} from "../../src/weeek/types.js";

// `satisfies Record<WeeekErrorCode, RegExp>` makes this table compile-time
// exhaustive in both directions: a new `WeeekErrorCode` fails
// `npm run typecheck:tests` until its self-correction phrase is pinned here,
// and a stale entry for a removed code fails too.
const CASES = {
  weeek_unauthorized: /WEEEK_ACCESS_TOKEN/,
  weeek_forbidden: /workspace role/,
  weeek_not_found: /id exists/,
  weeek_rate_limited: /Retry/,
  weeek_server_error: /5xx/,
  weeek_network: /WEEEK_BASE_URL/,
  weeek_timeout: /WEEEK_TIMEOUT_MS/,
  weeek_invalid_response: /upstream API contract/,
  // I8 (#42): "you sent something wrong" — the sentence must steer the agent
  // to its own arguments, not to a drift bug report.
  weeek_validation_error: /arguments/,
} satisfies Record<WeeekErrorCode, RegExp>;

const CASE_ROWS = Object.entries(CASES) as Array<[WeeekErrorCode, RegExp]>;

describe("humanMessage", () => {
  it.each(CASE_ROWS)(
    "%s → sentence containing the documented self-correction phrase",
    (code, phrase) => {
      const err = new WeeekError({
        code,
        message: "weeek http _",
      });
      const text = humanMessage(err);
      expect(text).toMatch(phrase);
      expect(text.length).toBeLessThanOrEqual(200);
    },
  );

  it("a locally-refused request does not claim Weeek rejected it (#46)", () => {
    // `WeeekRequestNotSentError` carries `weeek_validation_error` — the right
    // code, since the arguments were wrong — but the code's own sentence opens
    // with "Weeek rejected the request (HTTP 400/422)", and no request was
    // made. The class-keyed branch is what keeps the mapper truthful without
    // adding a tenth code to the taxonomy.
    const err = new WeeekRequestNotSentError("synthetic local refusal");
    expect(err.code).toBe("weeek_validation_error");
    const text = humanMessage(err);
    expect(text).toContain("was not sent");
    expect(text).not.toContain("HTTP 400/422");
    expect(text).not.toContain("Weeek rejected");
    // Still a correction the agent can act on, and still bounded.
    expect(text).toMatch(/arguments/);
    expect(text.length).toBeLessThanOrEqual(200);
  });

  it("a plain WeeekError with the same code keeps the upstream sentence", () => {
    // The branch above must not swallow the ordinary 400/422 case: that one
    // really did come back from Weeek.
    const err = new WeeekError({
      code: "weeek_validation_error",
      message: "weeek http 422",
      status: 422,
    });
    expect(humanMessage(err)).toContain("HTTP 400/422");
  });

  it("does not echo err.message into the returned sentence", () => {
    const err = new WeeekError({
      code: "weeek_unauthorized",
      message: "leak: tenant=acme-corp token=abcdefghijklmnopqrst",
      status: 401,
    });
    const text = humanMessage(err);
    expect(text).not.toContain("acme-corp");
    expect(text).not.toContain("abcdefghijklmnopqrst");
    expect(text).not.toContain("leak");
  });

  it("does not echo err.status / err.cause / err.stack", () => {
    const cause = { secret: "leaky-cause-payload" };
    const err = new WeeekError({
      code: "weeek_server_error",
      message: "weeek http 503",
      status: 503,
      cause,
    });
    const text = humanMessage(err);
    expect(text).not.toContain("503");
    expect(text).not.toContain("leaky-cause-payload");
  });

  // I8 (#42): the validation body is the one payload that *always* contains
  // submitted field values (`{"title":["The title field is required."]}`), so
  // the ninth code's sentence gets its own no-echo assertion on top of the
  // generic one above.
  it("weeek_validation_error never echoes the validation body", () => {
    const err = new WeeekError({
      code: "weeek_validation_error",
      message: 'weeek http 422 {"title":["leaky-submitted-value"]}',
      status: 422,
      cause: { errors: { title: ["leaky-submitted-value"] } },
    });
    const text = humanMessage(err);
    expect(text).not.toContain("leaky-submitted-value");
    expect(text).toMatch(/arguments/);
    // Code-derived, not status-derived: the 400 and the 422 that both map to
    // this code render the identical sentence. (The literal "400/422" in it
    // is a constant of the mapper, the same way "HTTP 401" is for
    // `weeek_unauthorized` — it never comes from `err.status`.)
    const from400 = humanMessage(
      new WeeekError({ code: "weeek_validation_error", message: "x", status: 400 }),
    );
    expect(from400).toBe(text);
  });

  it("default branch: synthetic unknown code falls through to a stable sentence", () => {
    // Bypass TS exhaustiveness via a runtime cast — exercises the assertNever
    // fallback that a future WeeekErrorCode addition would land in if the
    // mapper switch was not extended in lockstep.
    const err = new WeeekError({
      code: "weeek_future_code" as WeeekErrorCode,
      message: "weeek http _",
    });
    const text = humanMessage(err);
    expect(text).toMatch(/unrecognised error code/);
    expect(text).toMatch(/weeek_future_code/);
  });
});
