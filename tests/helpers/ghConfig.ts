import { readRepoFile } from "./srcTree.js";

// Text-scan helpers for the `.github/` YAML tree — one copy, shared by every
// invariant suite that reads a workflow or the Dependabot config as lines
// rather than through a YAML parser (there is none in the dependency tree, and
// buying one to assert a handful of facts would be a dependency added on a
// release increment's budget). `github-automation.test.ts` was the first
// consumer and `release-readiness.test.ts` the second; extracting these here
// follows the same rule `srcTree.ts` states for the src-grep helpers — "one
// copy, so a third gate does not have to reinvent the walk."

/**
 * A file's text with its `#` comments blanked out and the line count intact.
 *
 * A scan that could not tell `gh pr merge --auto` in a comment from the same in
 * a `run:` step would make documenting a decision impossible. Preserving the
 * line count is what lets `offenders` still name a line a reader can open.
 *
 * Trailing comments are cut at a `#` preceded by whitespace, which is where
 * YAML ends a value anyway. A `#` *inside* a quoted value would be cut too — no
 * such value exists in the files scanned, and one would be worth a second look.
 */
export const blanked = (rel: string): string =>
  readRepoFile(rel)
    .split("\n")
    .map((line) => {
      const at = line.search(/(?:^|\s)#/);
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");

/**
 * The configuration alone: comments gone, blank lines gone.
 *
 * Structural scans match across adjacent lines (`groups:` then the group name
 * then its selector), and a comment sitting between two keys is not a gap in
 * the structure. Line numbers do not survive this, which is why `blanked` stays
 * separate for the one scan that reports them.
 */
export const config = (rel: string): string =>
  blanked(rel)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .join("\n");

/**
 * The body of a workflow's top-level `on:` block, comments stripped.
 *
 * Slicing it out is what makes "triggers on push" mean the trigger rather than
 * any two-space key that happens to be spelled `push:`, and "declares a dispatch
 * trigger" mean the trigger rather than the word `workflow_dispatch` in a
 * comment. Ends at the next column-0 key.
 */
export const onBlock = (rel: string): string => {
  const lines = config(rel).split("\n");
  const start = lines.findIndex((l) => /^on:\s*$/.test(l));
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\S/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
};
