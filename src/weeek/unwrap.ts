import { WeeekError, type WeeekErrorCode } from "./types.js";

// Strip `username`/`password` from a URL before logging. The env loader
// rejects credentials in `WEEEK_BASE_URL` already (see `src/config/env.ts`),
// but per-request URLs assembled at runtime must still be sanitised before
// they reach any log line.
export function redactUrl(input: string): string {
  try {
    const url = new URL(input);
    if (url.username !== "" || url.password !== "") {
      url.username = "";
      url.password = "";
    }
    return url.toString();
  } catch {
    return "[invalid-url]";
  }
}

function codeForStatus(status: number): WeeekErrorCode {
  if (status === 401) return "weeek_unauthorized";
  if (status === 403) return "weeek_forbidden";
  if (status === 404) return "weeek_not_found";
  // I8 (#42): request-validation rejections. 400 is the documented case; 422
  // is the one the live API actually uses for per-field validation (bug #28
  // observed `{"completed":["The completed field must be true or false."]}`
  // on a 422). Before I8 both fell into the `weeek_invalid_response`
  // catch-all, which told the agent the API had drifted when in fact the
  // agent had sent a bad value. Reads see this too, by design.
  if (status === 400 || status === 422) return "weeek_validation_error";
  if (status === 429) return "weeek_rate_limited";
  if (status >= 500) return "weeek_server_error";
  return "weeek_invalid_response";
}

// Weeek wraps single-resource responses under varying keys (`user`, `project`,
// `task`, ...). Callers pass the expected key.
interface SuccessEnvelope {
  success: true;
  [k: string]: unknown;
}

// The half of the contract every 2xx Weeek response shares: HTTP success and
// a `success: true` envelope. Split out in I8 (#43) because the write routes
// answer with the envelope ALONE — `POST /tm/tasks/{id}/complete` returns
// `{"success":true}` and no resource key — so `parseWeeekAck` needs exactly
// this and nothing more. Keeping one implementation means an ack and a
// resource read map an HTTP status to the same `WeeekErrorCode`.
function requireSuccessEnvelope(status: number, body: unknown): SuccessEnvelope {
  if (status < 200 || status >= 300) {
    throw new WeeekError({
      code: codeForStatus(status),
      message: `weeek http ${String(status)}`,
      status,
    });
  }
  if (body === null || typeof body !== "object") {
    throw new WeeekError({
      code: "weeek_invalid_response",
      message: "weeek response was not a JSON object",
      status,
    });
  }
  const envelope = body as SuccessEnvelope;
  if (envelope.success !== true) {
    throw new WeeekError({
      code: "weeek_invalid_response",
      message: "weeek response missing success=true envelope",
      status,
    });
  }
  return envelope;
}

// Validate a bodyless Weeek acknowledgement — the `{ success: true }` a write
// route answers with when it has no resource to return. Returns nothing on
// purpose: there is no data here, and a caller that wants the resulting task
// must read it back (see `endpoints/tasksWrite.ts`). A `success: false` 200 is
// `weeek_invalid_response`, not a silent no-op.
export function parseWeeekAck(status: number, body: unknown): void {
  requireSuccessEnvelope(status, body);
}

// Parse a Weeek REST response body into the inner resource. The Weeek API
// returns `{ success: true, ...data }` on 2xx; non-2xx are mapped to
// `WeeekError` with a stable code. The function never copies response body
// fragments into `Error.message` (see INVARIANT-2 in `types.ts`).
export function parseWeeekResponse<T>(
  status: number,
  body: unknown,
  envelopeKey: string,
): T {
  const envelope = requireSuccessEnvelope(status, body);
  const inner = envelope[envelopeKey];
  if (inner === undefined || inner === null || typeof inner !== "object") {
    throw new WeeekError({
      code: "weeek_invalid_response",
      message: `weeek response missing key '${envelopeKey}'`,
      status,
    });
  }
  return inner as T;
}
