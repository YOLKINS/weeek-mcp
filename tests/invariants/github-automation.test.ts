import { readdirSync } from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import { offenders, readRepoFile, REPO_ROOT } from "../helpers/srcTree.js";
import { blanked, config, onBlock } from "../helpers/ghConfig.js";

// The `.github/` tree is configuration nobody runs locally and CI never fails
// on: a wrong `interval`, a lost group, a `write` scope that crept into a scan
// job all stay green forever. #58 turned dependency and code-scanning drift
// into something that arrives on its own, and this suite is what keeps the
// arrangement itself from drifting. #59 added the release workflow, whose
// every property is of the same kind — nothing about a publish path is
// exercised until the day it publishes, and that is the worst day to find out.
// That last one reaches one file outside `.github/`: `prepublishOnly` is the
// publish path a laptop takes, and RETRO-18 was precisely a disagreement
// between it and CI, so the chain is asserted against both from one list here
// rather than against neither from two.
//
// These are line scans, not a YAML parse — there is no YAML parser in the
// dependency tree, and buying one to assert a handful of facts about two files
// would be a dependency added on a release increment's budget. Each assertion
// is therefore written so a line scan can answer it *soundly*: "every
// ecosystem declared", "every interval declared", "every permission granted at
// write" are questions about the set of matching lines, not about a shape only
// a parser can see. Where a scan cannot be made sound, the limit is stated
// rather than papered over.

const DEPENDABOT = ".github/dependabot.yml";
const CODEQL = ".github/workflows/codeql.yml";
const RELEASE = ".github/workflows/release.yml";
const WORKFLOW_DIR = ".github/workflows";

/**
 * The pre-merge chain from `CLAUDE.md`, as the commands that run it.
 *
 * One copy, asserted against three places that must agree: `ci.yml` (what
 * every PR passes), `release.yml` (what a publish passes), and
 * `package.json:prepublishOnly` (what a publish from a laptop passes). RETRO-18
 * was exactly a disagreement between the first and the last — `coverage` ran in
 * CI and not on the publish path, so the per-glob V8 ratchet guarding all of
 * `src/**` was the one gate a hand-publish skipped. A list that is checked
 * against all three is what makes that a test failure rather than a sentence in
 * a document.
 */
const PRE_MERGE_CHAIN = [
  "npm run typecheck",
  "npm run typecheck:tests",
  "npm run lint",
  "npm test",
  "npm run coverage",
  "npm run build",
];

/** Every `.github/workflows/*.yml` in the tree, repo-root-relative. */
const workflowFiles = (): string[] =>
  readdirSync(path.join(REPO_ROOT, WORKFLOW_DIR))
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((f) => path.join(WORKFLOW_DIR, f));

/** First capture group of every match of `pattern` in `text`. */
const captures = (text: string, pattern: RegExp): string[] =>
  [...text.matchAll(pattern)].map((m) => m[1] ?? "");

/**
 * Every permission a workflow grants at `write`, by name.
 *
 * `^\s*` and not `^\s+`: a blanket `permissions: write-all` sits at column 0
 * and would be invisible to an indent-requiring scan — it surfaces here as the
 * name `permissions`, which is exactly what an exact-set assertion should
 * reject. An empty result means "no write scope anywhere", which is only
 * meaningful alongside the assertion below that the block exists at all.
 */
const writePermissions = (rel: string): string[] =>
  captures(config(rel), /^\s*([a-z-]+):\s*write(?:-all)?\b/gm);

describe("dependabot watches both ecosystems, weekly (#58)", () => {
  // `-?` because `package-ecosystem` need not be the list item's first key;
  // reordering the keys under an entry is valid YAML and not a regression.
  const ecosystems = (): string[] =>
    captures(
      config(DEPENDABOT),
      /^\s*-?\s*package-ecosystem:\s*"?([a-z-]+)"?\s*$/gm,
    ).sort();

  it("declares exactly npm and github-actions", () => {
    expect(ecosystems()).toEqual(["github-actions", "npm"]);
  });

  it("puts every update on a weekly schedule", () => {
    const intervals = captures(
      config(DEPENDABOT),
      /^\s*interval:\s*"?([a-z]+)"?\s*$/gm,
    );
    // Counted against the ecosystems rather than pinned to a literal pair: a
    // third ecosystem added *with* a schedule is not a regression, and a third
    // added without one is precisely what this must catch.
    expect(intervals).toHaveLength(ecosystems().length);
    expect([...new Set(intervals)]).toEqual(["weekly"]);
  });

  it("groups dev-dependency updates into one PR", () => {
    // Matched as a structure — `groups:`, a group name, its selector — because
    // `dependency-type: development` on its own is also legal under `allow:`
    // and `ignore:`, where it would mean the opposite of grouping.
    expect(config(DEPENDABOT)).toMatch(
      /^\s+groups:\n\s+[a-z-]+:\n\s+dependency-type:\s*"?development"?\s*$/m,
    );
  });
});

describe("no auto-merge, on any group (#58)", () => {
  // The posture, not the file: Dependabot has no auto-merge key of its own, so
  // "no auto-merge" is a claim about what the workflow tree does NOT contain.
  // A future release or bot workflow that reaches for one fails here, which is
  // the only place the decision can be re-argued rather than re-discovered.
  //
  // The limit worth knowing: this sees the repository's own files. GitHub's
  // per-PR "Enable auto-merge" button is a repository setting no test can
  // reach — that half stays maintainer-owned, like every other push-side
  // control in ADR 0001.
  const AUTO_MERGE =
    /gh pr merge|--auto\b|auto[-_]?merge|enable-pull-request-automerge/i;

  it.each([DEPENDABOT, ...workflowFiles()])(
    "%s configures no auto-merge",
    (rel) => {
      expect(offenders(blanked(rel), rel, AUTO_MERGE)).toEqual([]);
    },
  );
});

describe("codeql scans typescript on push, PR and a schedule (#58)", () => {
  it.each(["push", "pull_request", "schedule"])("triggers on %s", (trigger) => {
    expect(onBlock(CODEQL)).toMatch(new RegExp(`^ {2}${trigger}:`, "m"));
  });

  it("the schedule is weekly — a fixed day, not every day", () => {
    const crons = captures(
      onBlock(CODEQL),
      /^\s*-\s*cron:\s*['"]?([^'"\n]+?)['"]?\s*$/gm,
    );
    expect(crons).toHaveLength(1);
    const fields = (crons[0] ?? "").split(/\s+/);
    expect(fields).toHaveLength(5);
    // Day-of-week pinned is what makes it weekly; `* * * * *`-style wildcards
    // in that field would be a daily or hourly scan wearing the word "weekly".
    expect(fields[4]).not.toBe("*");
  });

  it("analyses typescript with no build", () => {
    const body = config(CODEQL);
    expect(body).toMatch(/^\s+languages:\s*javascript-typescript\s*$/m);
    expect(body).toMatch(/^\s+build-mode:\s*none\s*$/m);
  });

  it("grants exactly one write permission, and it is the SARIF upload", () => {
    expect(writePermissions(CODEQL)).toEqual(["security-events"]);
  });
});

describe("release publishes on a dispatch, never on a push (#59)", () => {
  it("declares workflow_dispatch and no other trigger", () => {
    // Read out of the `on:` block rather than the file: a tag push must not
    // reach the registry on its own, and `push:` is a common enough word in a
    // workflow that "the file does not say push" would be the wrong question.
    const keys = onBlock(RELEASE)
      .split("\n")
      .filter((l) => /^ {2}\S/.test(l))
      .map((l) => l.trim().replace(/:.*$/, ""));
    expect(keys).toEqual(["workflow_dispatch"]);
  });

  it("takes no inputs, so a dist-tag cannot become a parameter", () => {
    // `latest` is the only dist-tag this package has (ADR 0001 §6 retired the
    // `next`-vs-`latest` split), and an input is the easiest way to reintroduce
    // one by accident. Asserting the absence of inputs *entirely* is stronger
    // than asserting the absence of a dist-tag input, and it is the same
    // assertion a line scan can actually make soundly.
    expect(offenders(blanked(RELEASE), RELEASE, /inputs\s*:|inputs\./)).toEqual(
      [],
    );
  });

  it("grants exactly one write permission, and it is provenance", () => {
    // `id-token: write` is what mints the attestation. Anything else appearing
    // here would be a publish job that had also acquired the ability to write
    // to the repository.
    expect(writePermissions(RELEASE)).toEqual(["id-token"]);
    expect(config(RELEASE)).toMatch(/^\s+contents:\s*read\s*$/m);
  });

  it("publishes with provenance, naming no dist-tag", () => {
    const body = config(RELEASE);
    expect(body).toMatch(/npm publish\b[^\n]*--provenance/);
    // No `--tag` at all: `npm publish` defaults to `latest`, so the absence is
    // the guarantee — and it is one a scan can see, where "the only --tag value
    // is latest" would still leave the flag there to be edited.
    expect(offenders(blanked(RELEASE), RELEASE, /--tag\b/)).toEqual([]);
  });

  it("authenticates from a repository secret", () => {
    expect(config(RELEASE)).toMatch(
      /NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.[A-Z_]+\s*\}\}/,
    );
  });

  it("runs on a node version the ci matrix covers", () => {
    const ciMatrix = captures(
      config(".github/workflows/ci.yml"),
      /^\s*node:\s*\[([^\]]+)\]/gm,
    )
      .flatMap((list) => list.split(","))
      .map((v) => v.trim().replace(/^["']|["']$/g, ""));
    const releaseNode = captures(
      config(RELEASE),
      /^\s*node-version:\s*["']?([^"'\n]+?)["']?\s*$/gm,
    );
    expect(releaseNode).toHaveLength(1);
    expect(ciMatrix).toContain(releaseNode[0]);
  });
});

describe("the publish path runs the whole gate (#59, RETRO-18)", () => {
  /** Every single-line `run:` command a workflow declares. */
  const runCommands = (rel: string): string[] =>
    captures(config(rel), /^\s*-\s*run:\s*(\S.*?)\s*$/gm);

  for (const rel of [".github/workflows/ci.yml", RELEASE]) {
    it.each(PRE_MERGE_CHAIN)(`${rel} runs %s`, (cmd) => {
      expect(runCommands(rel)).toContain(cmd);
    });

    it(`${rel} re-checks the built dist/index.js`, () => {
      // The one gate that is not an `npm run` script: the executable bit and
      // the shebang exist only after `postbuild`, so nothing in the chain
      // above can see them. It is copied into both workflows, and a copy
      // nothing binds is a copy that drifts.
      expect(config(rel)).toMatch(/test -x dist\/index\.js/);
      expect(config(rel)).toMatch(/#!\/usr\/bin\/env node/);
    });
  }

  it("prepublishOnly runs the same chain, coverage included", () => {
    // The belt for the case the workflow is not the path taken — an emergency
    // publish from a laptop. Split on `&&` and compared as whole commands, so
    // `npm run typecheck` cannot satisfy this by being a prefix of
    // `npm run typecheck:tests`.
    const pkg = JSON.parse(readRepoFile("package.json")) as {
      scripts: Record<string, string>;
    };
    const steps = (pkg.scripts.prepublishOnly ?? "")
      .split("&&")
      .map((s) => s.trim());
    for (const cmd of PRE_MERGE_CHAIN) expect(steps).toContain(cmd);
  });
});

describe("release guards run, and run before the publish (#59)", () => {
  // What a line scan can see here is the wiring, not the shell semantics: that
  // the tag guard reads the ref GitHub dispatched against and the version the
  // repository declares, that the registry guard asks npm what is published,
  // and — the part that makes both worth having — that each sits *before* the
  // publish step. A guard that runs after `npm publish` is not a guard. That
  // the comparisons exit non-zero is left to review; the alternative was to
  // move the guards into a script this suite could execute, which buys the
  // assertion at the price of putting the release logic somewhere no reader of
  // the workflow would look for it.
  const offsetOf = (pattern: RegExp): number => config(RELEASE).search(pattern);

  it("the tag guard reads the dispatched ref and the declared version", () => {
    expect(offsetOf(/github\.ref_type/)).toBeGreaterThan(-1);
    expect(offsetOf(/github\.ref_name/)).toBeGreaterThan(-1);
    expect(offsetOf(/require\('\.\/package\.json'\)\.version/)).toBeGreaterThan(
      -1,
    );
  });

  it("the registry guard asks npm which versions exist", () => {
    expect(offsetOf(/npm view\b[^\n]*\bversions\b/)).toBeGreaterThan(-1);
  });

  it.each<[string, RegExp]>([
    ["tag guard", /github\.ref_type/],
    ["registry guard", /npm view\b[^\n]*\bversions\b/],
  ])("%s runs before npm publish", (_label, pattern) => {
    const publishAt = offsetOf(/npm publish\b/);
    expect(publishAt).toBeGreaterThan(-1);
    expect(offsetOf(pattern)).toBeLessThan(publishAt);
  });
});

describe("every workflow narrows its token (#58)", () => {
  // Two assertions, because either alone passes for the wrong reason: an
  // exact-set check on write scopes reads a *deleted* `permissions:` block as
  // "grants nothing", when what it actually means is "takes the repository
  // default", which on a private repo is a read/write token.
  it.each(workflowFiles())("%s declares a permissions block", (rel) => {
    expect(config(rel)).toMatch(/^permissions:/m);
  });

  it.each(["ci.yml", "live-smoke.yml"])("%s grants no write scope", (name) => {
    expect(writePermissions(path.join(WORKFLOW_DIR, name))).toEqual([]);
  });
});
