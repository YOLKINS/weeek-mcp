import { describe, it, expect } from "vitest";
import { offenders, readRepoFile, srcFiles } from "../helpers/srcTree.js";

// A double assertion — `x as unknown as T` and its `any` / `never` variants —
// is the one construct that silences the type checker completely: `unknown` is
// comparable to everything, so the second `as` can name any type at all and no
// compile error survives to say so. Single `as` narrowings are not the target
// (`err as WeeekError` after an `instanceof` is honest), and neither is a
// generic call that happens to be instantiated at `unknown`
// (`parseWeeekResponse<unknown>(...)` — inference, not an assertion). The
// escape hatch is. `\s` spans newlines, so a wrapped assertion is caught too.
const DOUBLE_ASSERTION = /\bas\s+(?:unknown|any|never)\s+as\b/;

describe("no hand-written escape hatch in src/ (RETRO-19)", () => {
  // RETRO-19's subject was `applyResponseLimits` returning
  // `sc as unknown as S`: the gate built `truncated` onto a value the caller
  // had typed without it, and the double assertion was how the two were
  // reconciled. I9 (#55) made `truncated` part of the type the gate produces,
  // which removed the last one. The grep is what keeps "last" true — a future
  // handler that reaches for the hatch fails here rather than in review, and
  // the failure names the file and line. Tests are deliberately out of scope:
  // a test asserting a deliberately malformed payload past the compiler is
  // stating its case, not hiding one.
  it("no file under src/ contains a double type assertion", () => {
    const hits = srcFiles().flatMap((f) =>
      offenders(readRepoFile(f), f, DOUBLE_ASSERTION),
    );
    expect(hits).toEqual([]);
  });
});
