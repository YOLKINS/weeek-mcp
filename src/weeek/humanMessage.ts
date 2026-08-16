import {
  WeeekRequestNotSentError,
  type WeeekError,
  type WeeekErrorCode,
} from "./types.js";

// INVARIANT-7: tool error `content[0].text` carries this self-correction
// sentence after the stable `<tool> failed (<code>):` prefix. Switches on
// `err.code` (and, for the one case below, on the error's CLASS); never reads
// `err.message`, `err.cause`, `err.status`, or any other field that could echo
// response-body fragments (defence-in-depth over `WeeekError` INVARIANT-2 in
// `src/weeek/types.ts`). English-only in I6.5-ux; RU translation lands in I9
// i18n pass.
export function humanMessage(err: WeeekError): string {
  // I8 (#46) — the one error the code alone cannot describe. A locally-refused
  // request carries `weeek_validation_error` because that is what it is ("you
  // sent something wrong"), but the code's own sentence opens with "Weeek
  // rejected the request (HTTP 400/422)" — untrue when Weeek never saw it, and
  // an agent that reads a false HTTP claim and then a retraction has been told
  // two things. Branching on the class is body-free (it reads no field at all),
  // so INVARIANT-2 is untouched and INVARIANT-7 stays literally true: this
  // mapper is still the single source of every agent-visible sentence.
  if (err instanceof WeeekRequestNotSentError) {
    return "The request was not sent — this server rejected the arguments before calling Weeek, so nothing was changed. Correct the arguments and re-issue.";
  }
  return messageForCode(err.code);
}

function messageForCode(code: WeeekErrorCode): string {
  switch (code) {
    case "weeek_unauthorized":
      return "Weeek rejected the access token (HTTP 401). Check that WEEEK_ACCESS_TOKEN is set, not expired, and copied without surrounding whitespace.";
    case "weeek_forbidden":
      return "Weeek refused the request (HTTP 403). The token is valid but lacks permission for this resource; verify the user's workspace role.";
    case "weeek_validation_error":
      return "Weeek rejected the request as invalid (HTTP 400/422). Correct the arguments — check ids, required fields, and value types — then retry.";
    case "weeek_not_found":
      return "Weeek returned 404 for this resource. Verify the id exists in the configured workspace and was not deleted.";
    case "weeek_rate_limited":
      return "Weeek rate-limited the request (HTTP 429). Retry after a brief delay or reduce the call frequency.";
    case "weeek_server_error":
      return "Weeek returned a server error (HTTP 5xx). Retry shortly; if the failure persists, check Weeek's status page.";
    case "weeek_network":
      return "Could not reach Weeek over the network. Check the host's internet connection and the WEEEK_BASE_URL value.";
    case "weeek_timeout":
      return "The Weeek request exceeded WEEEK_TIMEOUT_MS. Retry, or raise WEEEK_TIMEOUT_MS if the workspace is unusually large.";
    case "weeek_invalid_response":
      return "Weeek returned an unexpected response shape. Retry once; if it persists, the upstream API contract may have drifted — file an issue.";
    default:
      return assertNever(code);
  }
}

function assertNever(value: never): string {
  // Runtime fallback for an unmapped code (only reachable if a future
  // `WeeekErrorCode` is added without updating this switch — TypeScript fails
  // to compile in that case, so this branch is a defence-in-depth, not a
  // happy path).
  return `Weeek returned an unrecognised error code (${String(value)}). Retry shortly.`;
}
