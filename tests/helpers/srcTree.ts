import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Two invariant gates grep the source tree for a construct that must not come
// back — `version-cadence` for a live `-rc` / `--tag next` string, and
// `type-assertions` for a double type assertion. Both need the same two
// things: the list of `.ts` files under `src/`, and a way to turn a hit into
// a `file:line: text` string a failure message can name. One copy, so a third
// gate does not have to reinvent the walk.

const __filename = fileURLToPath(import.meta.url);

/**
 * Absolute path to the repository root.
 *
 * Exported because it is not this module's private business: three suites now
 * need it (the two grep gates below, the `dist/` spawn plumbing in
 * `distServer.ts`, and the pack-manifest gate), and a fourth copy of
 * `fileURLToPath(import.meta.url)` + `"../.."` is a walk that only stays
 * correct until someone moves a file one directory.
 */
export const REPO_ROOT = path.join(path.dirname(__filename), "../..");

/** Every `.ts` file under `src/`, as a repo-root-relative path. */
export const srcFiles = (): string[] =>
  (readdirSync(path.join(REPO_ROOT, "src"), { recursive: true }) as string[])
    .filter((f) => typeof f === "string" && f.endsWith(".ts"))
    .map((f) => path.join("src", f));

/** Contents of a repo-root-relative file. */
export const readRepoFile = (rel: string): string =>
  readFileSync(path.join(REPO_ROOT, rel), "utf8");

/**
 * `file:line: text` for every match of `pattern` in `text`.
 *
 * Matches are located in the whole file rather than line by line: a construct
 * that a formatter wrapped across two lines is the same construct, and a
 * per-line scan would let it through. The line number is derived from the
 * match offset so the failure still points at a place a reader can open.
 */
export function offenders(
  text: string,
  label: string,
  pattern: RegExp,
): string[] {
  const rx = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);
  const found: string[] = [];
  for (const m of text.matchAll(rx)) {
    const line = text.slice(0, m.index).split("\n").length;
    const source = text.split("\n")[line - 1] ?? m[0];
    found.push(`${label}:${String(line)}: ${source.trim()}`);
  }
  return found;
}
