import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import { REPO_ROOT } from "../helpers/srcTree.js";

// The published artifact ships what a consumer runs and reads, and nothing
// else. `package.json:files` is an allowlist, so the default is already
// exclusion — but the default is invisible: adding `CONTRIBUTING.md` to the
// repo root is a silent no-op on the tarball today and would become a silent
// inclusion the moment someone "tidies" the allowlist into an `.npmignore`
// deny-list. RETRO-17 already answered the same question for `examples/` in
// prose ("`examples/` lives on GitHub only"), and prose is what drifts.
//
// This gate reads the actual pack manifest rather than the config that
// produces it, so it holds whichever mechanism is in force.

/**
 * Everything the tarball may carry outside `dist/`.
 *
 * `package.json` is on the list because npm always packs it; the other three
 * are `package.json:files` verbatim. `dist/**` is deliberately NOT pinned —
 * its contents are a build output that moves with every increment, and this
 * suite runs before `npm run build` in the CI chain, so a fresh checkout has
 * no `dist/` to enumerate. What matters here is the boundary, not the payload.
 */
const PACKED_OUTSIDE_DIST = [
  "LICENSE",
  "README.md",
  "README.ru.md",
  "package.json",
];

/**
 * Repo-root files that exist for GitHub / tooling readers and must stay off npm.
 *
 * Listing them explicitly is not redundant with the exact-set assertion above:
 * that one fails if a file sneaks *in*, this one fails if a file quietly stops
 * existing, which would leave the first assertion passing for the wrong
 * reason. A `SECURITY.md` that was deleted is not a `SECURITY.md` kept out of
 * the tarball. `server.json` (I9, #61) is the MCP registry manifest — a
 * repository-side artefact the registry reads from GitHub, never something a
 * consumer runs, so it belongs here too: the ownership marker it pairs with
 * ships inside `package.json`, but the manifest itself does not.
 */
const GITHUB_ONLY_ROOT_DOCS = [
  "CLAUDE.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "server.json",
];

interface PackManifest {
  readonly files: readonly { readonly path: string }[];
}

/**
 * Paths `npm pack` would put in the tarball, per its own dry-run manifest.
 *
 * Memoised: every assertion below asks the same question of the same tree, and
 * each call is a full `npm` spawn. One spawn per run, not one per `it`.
 */
let cached: string[] | undefined;
function packedPaths(): string[] {
  if (cached) return cached;
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    // npm writes the human-readable tarball listing to stderr even under
    // `--json`; only stdout is the manifest.
    stdio: ["ignore", "pipe", "ignore"],
  });
  const manifests = JSON.parse(raw) as PackManifest[];
  cached = manifests.flatMap((m) => m.files.map((f) => f.path));
  return cached;
}

describe("npm tarball boundary (#57)", () => {
  it("packs nothing outside dist/ but the four documented files", () => {
    const outsideDist = packedPaths()
      .filter((p) => !p.startsWith("dist/"))
      .sort();
    expect(outsideDist).toEqual(PACKED_OUTSIDE_DIST);
  }, 60_000);

  it.each(GITHUB_ONLY_ROOT_DOCS)("%s exists but is not packed", (doc) => {
    expect(existsSync(path.join(REPO_ROOT, doc)), `${doc} is missing`).toBe(
      true,
    );
    expect(packedPaths()).not.toContain(doc);
  }, 60_000);
});
