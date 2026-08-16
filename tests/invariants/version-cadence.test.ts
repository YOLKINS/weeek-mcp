import { describe, it, expect } from "vitest";
import {
  offenders,
  readRepoFile as read,
  srcFiles,
} from "../helpers/srcTree.js";

// Version-cadence guard (finish-I7, ticket #21) — machine-checks the
// linear versioning model (ADR 0001 rule 6) so the `-rc` / `--tag next` /
// `next`-vs-`latest` drift that this increment reconciled cannot silently
// come back. Two contracts:
//
//   (a) BYTE-EQUALITY. `package.json` version == the `src/index.ts`
//       `McpServer` version literal, and both are plain SemVer `n.n.n`
//       (no `-rc` / prerelease suffix). This is the A8 gate: the runtime
//       `serverInfo.version` advertised over `tools/list` can never drift
//       from the published package version again (the P1 finding).
//
//   (b) NO LIVE `-rc` / `--tag next`. The user- and agent-facing live
//       surface (READMEs, CLAUDE.md, package.json, all of `src/**`)
//       carries zero live `-rc.N` / `--tag next` strings.
//
// Deliberately NOT policed by this guard:
//   * `` No `-rc` `` policy prose (bare `-rc`, no `.N` — does not match).
//   * `weeek-mcp@next` install commands in the READMEs / examples — those
//     are an install-UX concern, not a version stamp; the regex below does
//     not match `@next`.

// A *live* rc / dist-tag string: a real prerelease version suffix
// (`-rc.1`, `-rc.12`) or the retired dist-tag publish flag (`--tag next`).
const LIVE_RC_OR_TAG = /-rc\.\d|--tag next/;

const SEMVER = /^\d+\.\d+\.\d+$/;

/** repo-root-relative files that must never carry a live `-rc` / `--tag next`. */
const LIVE_SURFACE = [
  "README.md",
  "README.ru.md",
  "CLAUDE.md",
  "package.json",
  ...srcFiles(),
];

describe("version cadence — byte-equality (A8)", () => {
  it("package.json version equals the src/index.ts McpServer version literal", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    const m = read("src/index.ts").match(
      /name:\s*"weeek-mcp",\s*version:\s*"([^"]+)"/,
    );
    expect(m, "src/index.ts must declare a McpServer version literal").not.toBeNull();
    expect(m![1]).toBe(pkg.version);
  });

  it("the shared version is plain SemVer n.n.n — no -rc / prerelease suffix", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    expect(pkg.version).toMatch(SEMVER);
  });
});

describe("version cadence — no live -rc / --tag next on the live surface", () => {
  for (const rel of LIVE_SURFACE) {
    it(`${rel} carries no live -rc.N / --tag next string`, () => {
      expect(offenders(read(rel), rel, LIVE_RC_OR_TAG)).toEqual([]);
    });
  }
});
