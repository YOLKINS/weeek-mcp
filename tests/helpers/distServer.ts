import { spawn, execSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { REPO_ROOT } from "./srcTree.js";

// Shared plumbing for the two suites that exercise the *built* artifact
// rather than the in-process registry: the INVARIANT-11 stdio-cleanliness
// smoke and the I8-seal `tools/list` wire pin. Both need the same two
// things — a `dist/index.js` that exists, and a spawn carrying a
// placeholder token — and neither should own that for the other.

export const DIST_INDEX = path.join(REPO_ROOT, "dist/index.js");

/** Newest mtime under a directory tree, in ms. */
function newestMtime(dir: string): number {
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((f) => statSync(path.join(dir, f)).mtimeMs)
    .reduce((a, b) => Math.max(a, b), 0);
}

/**
 * Build `dist/` when it is missing **or older than `src/`**.
 *
 * Missing-only would be enough for a fresh checkout, but not for what these
 * suites assert. The seal pins the literal 10 / 15 tool counts against the
 * built binary, and a `dist/` left over from an earlier branch would make that
 * assertion measure the wrong server — a false red on a pre-I8 build, and the
 * far worse false green on a stale post-I8 one. Comparing mtimes costs a
 * directory walk and removes the whole class.
 *
 * `stdio:"inherit"` surfaces build errors directly to the vitest output.
 */
export function ensureBuilt(): void {
  const stale =
    !existsSync(DIST_INDEX) ||
    newestMtime(path.join(REPO_ROOT, "src")) > statSync(DIST_INDEX).mtimeMs;
  if (stale) {
    execSync("npm run build", { cwd: REPO_ROOT, stdio: "inherit" });
  }
}

/**
 * Spawn the built server with a syntactically-valid placeholder token and the
 * caller's env overrides on top. No Weeek call is made by startup itself, so
 * the token never has to be real.
 *
 * An override of `undefined` *unsets* the variable — `child_process` drops
 * undefined values when it builds the child's env rather than passing the
 * string `"undefined"`. That is the only way a caller can reach the
 * required-variable failure path at all, since this helper supplies the token
 * by default (#54, the alias-only startup case).
 */
export function spawnServer(
  env: Record<string, string | undefined>,
): ChildProcessWithoutNullStreams {
  return spawn("node", [DIST_INDEX], {
    env: {
      ...process.env,
      WEEEK_ACCESS_TOKEN: "x".repeat(32),
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}
