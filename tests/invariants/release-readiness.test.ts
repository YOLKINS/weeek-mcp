import { describe, it, expect } from "vitest";
import { offenders, readRepoFile as read } from "../helpers/srcTree.js";
import { config, onBlock } from "../helpers/ghConfig.js";
import { ALL_TOOLS } from "../helpers/toolNames.js";

// Release-readiness ratchet (I9, #60) — the one test seam this increment adds.
// Every ticket before it made a repository-level promise; this file is what
// makes those promises machine-checked, so the *next* increment cannot quietly
// unmake them. It has two halves that share a single rule: assert STRUCTURE and
// NAMED ENTITIES, never PROSE.
//
//   (A) README EN <-> RU PARITY. `README.md` and `README.ru.md` must stay
//       structurally parallel: identical heading level-sequences, the same set
//       of `weeek_*` identifiers, the same set of environment-variable names.
//       A parity claim maintained by a human reading two files in two languages
//       has a short shelf life; a parity claim maintained by CI survives whoever
//       is not paying attention. The comparison is deliberately blind to
//       wording — a re-translated paragraph must not fail CI, only a section /
//       tool / env var present on one side and missing on the other.
//
//   (B) RELEASE READINESS. The four infrastructure tickets (#57 community
//       files, #58 Dependabot + CodeQL, #59 release workflow + `prepublishOnly`
//       coverage) each left an artefact on disk. This half asserts each artefact
//       is actually there and carries the one fact that made the ticket worth
//       doing — at the altitude of "the promise exists", not "the promise is
//       shaped exactly so".
//
// -------------------------------------------------------------------------
// DELIBERATELY NOT POLICED by this ratchet. This block is load-bearing: it is
// what stops a future maintainer from "fixing" a failure by broadening the file
// into a prose checker or into a second copy of a suite that already exists.
//
//   * PROSE. Sentence wording, paragraph order, table-cell phrasing, the
//     contents of the example JSON blocks. Half (A) reads headings, `weeek_*`
//     tokens and env-var names and nothing else; a translator may rewrite every
//     sentence between two headings and this stays green. That is the point.
//
//   * The DEEP STRUCTURE of the `.github/` tree — exact write-permission sets,
//     the guards' run-before-publish ordering, `workflow_dispatch` being the
//     *only* trigger, the weekly cron field. `github-automation.test.ts` owns
//     all of that. Half (B) asserts the coarse readiness fact (the trigger, the
//     provenance flag, the two ecosystems, the language) and stops there, so it
//     is a roll-up gate rather than a duplicate of that suite. When a workflow's
//     shape is wrong, that suite fails; when a workflow's promise is *absent*,
//     this one does.
//
//   * The npm TARBALL BOUNDARY and the bare existence of the community docs —
//     `packaging.test.ts` owns both (it packs a dry-run manifest and asserts the
//     three docs exist-but-are-not-packed). Half (B) adds only the thing that
//     suite does not check: that each of those docs is NON-STUB.
//
//   * The src-side removal of the retired env aliases — `env.test.ts` owns it
//     (a grep over `src/**` plus a zero-warns assertion). Half (A) guards only
//     the two READMEs, where a reinstated alias would re-teach an operator a
//     name the server no longer accepts.
//
//   * Parity for any file that is NOT one of the two READMEs. `CLAUDE.md` and
//     `docs/**` are single-language records; the parity contract is
//     README.md <-> README.ru.md, nothing wider.
// -------------------------------------------------------------------------

const EN = "README.md";
const RU = "README.ru.md";

/**
 * The heading level-sequence of a Markdown file — `[1, 2, 2, 3, ...]`.
 *
 * Fence-aware: a `#` at the start of a line inside a ``` code block is shell or
 * a comment, not a heading, and counting it would make a fenced snippet a
 * structural element. The sequence (not just the multiset) is compared, so a
 * section moved to a different nesting depth on one side is caught, not only a
 * section added or removed.
 */
const headingLevels = (rel: string): number[] => {
  const levels: number[] = [];
  let inFence = false;
  for (const line of read(rel).split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s/.exec(line);
    if (m) levels.push(m[1]!.length);
  }
  return levels;
};

/** The sorted set of distinct `weeek_*` identifiers a file names. */
const weeekIdentifiers = (rel: string): string[] =>
  [...new Set(read(rel).match(/\bweeek_[a-z][a-z0-9_]*\b/g) ?? [])].sort();

/**
 * The sorted set of distinct environment-variable names a file names.
 *
 * Scoped to the configuration and integration env vars the READMEs document —
 * the whole `WEEEK_*` family (the runtime `WEEEK_ACCESS_TOKEN` / `WEEEK_BASE_URL`
 * / `WEEEK_TIMEOUT_MS` and the live-suite `WEEEK_INTEGRATION_*` / `WEEEK_TEST_*`),
 * the gate (`READ_ONLY`), the allowlist (`ENABLED_TOOLS`), the response budget
 * (`MAX_RESPONSE_CHARS`), the logger threshold (`LOG_LEVEL`) — rather than every
 * ALL-CAPS token, so a shared acronym like `HTTP` or `JSON` cannot masquerade as
 * a configuration variable. `\bWEEEK_` will not match inside the
 * `YOUR_WEEEK_TOKEN_HERE` placeholder (no word boundary after the leading
 * underscore), so a placeholder value is not read as a variable name.
 */
const envNames = (rel: string): string[] =>
  [
    ...new Set(
      read(rel).match(
        /\b(?:WEEEK_[A-Z0-9_]+|READ_ONLY|ENABLED_TOOLS|MAX_RESPONSE_CHARS|LOG_LEVEL)\b/g,
      ) ?? [],
    ),
  ].sort();

// The two env aliases removed for 1.0.0 (#54). `env.test.ts` enforces they are
// gone from `src/**`; here they must be gone from both READMEs, or the parity
// set would enshrine a name the server rejects. One copy of the list per side
// of the removal is deliberate — a single shared export would couple two
// unrelated enforcement points.
const REMOVED_ALIASES = ["WEEEK_API_TOKEN", "WEEEK_API_BASE_URL"] as const;

describe("README EN <-> RU parity — structure, never prose (#60)", () => {
  it("has identical heading level-sequences on both sides", () => {
    expect(headingLevels(EN)).toEqual(headingLevels(RU));
  });

  it("names the same set of weeek_* identifiers on both sides", () => {
    expect(weeekIdentifiers(EN)).toEqual(weeekIdentifiers(RU));
  });

  it.each([EN, RU])("documents every weeek_* tool in %s", (rel) => {
    const named = new Set(weeekIdentifiers(rel));
    const missing = ALL_TOOLS.filter(
      (t) => t.startsWith("weeek_") && !named.has(t),
    );
    expect(missing, `undocumented tools in ${rel}`).toEqual([]);
  });

  it.each([EN, RU])("names the ping tool in %s", (rel) => {
    // `ping` is the one registered tool outside the `weeek_*` family, so the
    // identifier-set parity above cannot see it; it is checked on its own so a
    // README that dropped it does not pass for lack of a pattern that matches.
    expect(read(rel)).toMatch(/\bping\b/);
  });

  it("names the same set of environment variables on both sides", () => {
    expect(envNames(EN)).toEqual(envNames(RU));
  });

  it.each([EN, RU])("names no removed env alias in %s", (rel) => {
    const named = new Set(envNames(rel));
    const reinstated = REMOVED_ALIASES.filter((a) => named.has(a));
    expect(reinstated, `removed aliases resurfaced in ${rel}`).toEqual([]);
  });
});

// --- Release readiness -----------------------------------------------------
// `config` / `onBlock` read the `.github/` YAML as comment-stripped lines; they
// live in `../helpers/ghConfig.ts` because `github-automation.test.ts` needs
// the same walk, and one copy is the rule `srcTree.ts` states for scan helpers.

const COMMUNITY_DOCS = [
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
] as const;

const RELEASE = ".github/workflows/release.yml";
const CODEQL = ".github/workflows/codeql.yml";
const DEPENDABOT = ".github/dependabot.yml";

describe("community documents are on disk and non-stub (#57)", () => {
  // "Non-stub" is three cheap facts a placeholder fails and a real document
  // clears with room to spare: it is more than a title-plus-TODO of prose, it
  // is sectioned, and it makes no unfinished-work promise. The 800-char floor is
  // "clearly more than a placeholder", not a length quota — the three real docs
  // are 5-9 KB. `packaging.test.ts` already asserts these files EXIST; this is
  // the part it does not check.
  const MIN_DOC_CHARS = 800;
  const STUB_MARKER = /\b(?:TODO|FIXME|TBD|coming soon|lorem ipsum)\b/i;

  it.each(COMMUNITY_DOCS)("%s is substantial, sectioned and stub-free", (rel) => {
    const body = read(rel);
    expect(body.length, `${rel} is too short to be real`).toBeGreaterThanOrEqual(
      MIN_DOC_CHARS,
    );
    const headings = body.split("\n").filter((l) => /^#{1,6}\s/.test(l));
    expect(headings.length, `${rel} has no section headings`).toBeGreaterThan(1);
    expect(offenders(body, rel, STUB_MARKER)).toEqual([]);
  });
});

describe("release workflow declares dispatch, provenance and id-token (#59)", () => {
  it("declares the workflow_dispatch trigger", () => {
    expect(onBlock(RELEASE)).toMatch(/^ {2}workflow_dispatch:/m);
  });

  it("grants id-token: write to mint provenance", () => {
    expect(config(RELEASE)).toMatch(/^\s*id-token:\s*write\b/m);
  });

  it("publishes with --provenance", () => {
    expect(config(RELEASE)).toMatch(/npm publish\b[^\n]*--provenance/);
  });
});

describe("dependency and code scanning are configured (#58)", () => {
  it("Dependabot covers both npm and github-actions", () => {
    const ecosystems = new Set(
      [...config(DEPENDABOT).matchAll(/package-ecosystem:\s*"?([a-z-]+)"?/g)].map(
        (m) => m[1],
      ),
    );
    expect(ecosystems.has("npm"), "npm ecosystem missing").toBe(true);
    expect(
      ecosystems.has("github-actions"),
      "github-actions ecosystem missing",
    ).toBe(true);
  });

  it("CodeQL analyses TypeScript", () => {
    // `javascript-typescript` is the identifier that covers the TS surface;
    // asserting the substring keeps this green if a second language is ever
    // added alongside it.
    expect(config(CODEQL)).toMatch(/languages:\s*[^\n]*javascript-typescript/);
  });
});

describe("the laptop publish path runs coverage (#59, RETRO-18)", () => {
  it("prepublishOnly includes npm run coverage", () => {
    const pkg = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };
    const steps = (pkg.scripts.prepublishOnly ?? "")
      .split("&&")
      .map((s) => s.trim());
    expect(steps).toContain("npm run coverage");
  });
});
