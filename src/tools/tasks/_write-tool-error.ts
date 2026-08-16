import { WeeekError } from "../../weeek/types.js";
import { humanMessage } from "../../weeek/humanMessage.js";
import { logger } from "../../logging/logger.js";
import type { ErrorPayload } from "../_response-limits.js";

// The error leg every write tool shares, extracted at the rule of three
// (#43 complete, #44 move, #45 create). Four promises live here, and each one
// is a whole-surface invariant that a hand-copied catch block could break in
// one tool without any other tool noticing:
//
//   INVARIANT-6 — a handler never throws on a `WeeekError`; it returns
//                 `{ isError: true, … }`.
//   INVARIANT-7 — the text is exactly `<tool> failed (<code>): <sentence>`,
//                 with `humanMessage(err)` as the sentence.
//   INVARIANT-9 — the warn ctx is `{ code, status }` and nothing else, and no
//                 fragment of `err.message` reaches the agent-visible text.
//   ADR 0004    — a LANDED write says so, in a sentence appended AFTER the
//                 standard prefix rather than replacing it.
//
// `landedNote` is the one part that genuinely differs per tool, because what
// a landed-but-unreadable write means to an agent differs per tool: safe to
// retry for the idempotent completion toggle, a duplicate card for a move, a
// whole second task for a create. Callers pass "" when the write did not land.
export function writeToolError(
  toolName: string,
  err: WeeekError,
  landedNote: string,
): ErrorPayload {
  logger.warn(`${toolName} failed`, { code: err.code, status: err.status });
  return {
    content: [
      {
        type: "text",
        text: `${toolName} failed (${err.code}): ${humanMessage(err)}${landedNote}`,
      },
    ],
    isError: true,
  };
}
