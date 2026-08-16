import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readRepoFile as read } from "../helpers/srcTree.js";
import { loadConfig, type EnvConfig } from "../../src/config/env.js";

// MCP Registry manifest gate (I9, #61) — the repository-side half of the
// registry listing, landed ahead of the `1.0.0` seal so the ownership marker
// rides in the published tarball rather than needing a patch release to carry
// it. The submission itself is a one-time, maintainer-owned external action;
// what this file guards is that the two on-disk artefacts — `server.json` (the
// manifest) and `package.json:mcpName` (the ownership marker) — stay TRUE to
// the package they describe, because a manifest is checked by a human once at
// submission and then trusted forever.
//
// The mechanism this is built against was verified on 2026-07-23 at the
// registry's own docs (docs/reference/server-json/*, docs/modelcontextprotocol-
// io/quickstart.mdx): a root `server.json` whose `name` equals `package.json`'s
// `mcpName`, both under the maintainer's GitHub namespace `io.github.<user>/…`,
// validated against the pinned schema below.
//
// The namespace CASE is load-bearing and cost us a near-miss. The registry
// issues the grant as `io.github.<login>/*` in the login's canonical spelling
// and matches submissions with `strings.HasPrefix` — a case-SENSITIVE compare
// (internal/auth/jwt.go; modelcontextprotocol/registry#689). A lowercased
// `mcpName` therefore 403s against a `YOLKINS` grant. Worse, the registry
// reads `mcpName` out of npm's IMMUTABLE version document, so a wrong case
// shipped in a published tarball is only fixable by cutting a new version.
// Hence the assertion below derives the expected spelling from
// `repository.url` rather than pinning a literal: that URL is the same string
// npm's provenance check compares against the OIDC claim, also case-
// sensitively, so one spelling stays true for both and survives a rename.
//
// The load-bearing decision here is the VERSION RATCHET. `server.json`'s
// versions are asserted equal to `package.json`'s, not pinned to a literal —
// so the `1.0.0` seal that bumps the package cannot ship a manifest still
// advertising `0.3.0`. A manifest version is a promise about which tarball
// carries the marker; a promise a human has to remember to update is exactly
// the class of drift this repo turns into a test.

/** The schema version the manifest is pinned to — bumping it is a deliberate
 * edit, the same discipline CLAUDE.md's "Tech stack pinning" applies to the
 * protocol and SDK versions. Verified current at the registry docs on
 * 2026-07-23. */
const PINNED_SCHEMA =
  "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";

/** The registry's own `name` pattern (server.schema.json): a reverse-DNS
 * namespace, one slash, a server identifier. */
const NAME_PATTERN = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;

const SEMVER = /^\d+\.\d+\.\d+$/;

interface EnvVar {
  readonly name: string;
  readonly description?: string;
  readonly isRequired?: boolean;
  readonly isSecret?: boolean;
  readonly default?: string;
  readonly format?: string;
}

interface ServerPackage {
  readonly registryType: string;
  readonly registryBaseUrl?: string;
  readonly identifier: string;
  readonly version: string;
  readonly transport: { readonly type: string };
  readonly environmentVariables?: readonly EnvVar[];
}

interface ServerManifest {
  readonly $schema: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly repository: { readonly url: string; readonly source: string };
  readonly packages: readonly ServerPackage[];
}

interface PackageJson {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly mcpName: string;
  readonly repository: { readonly url: string };
}

const manifest = JSON.parse(read("server.json")) as ServerManifest;
const pkg = JSON.parse(read("package.json")) as PackageJson;
const npmPackage = manifest.packages[0];
const envByName = new Map(
  (npmPackage?.environmentVariables ?? []).map((e) => [e.name, e]),
);

// Every env key `loadConfig` knows about, so the defaults below are derived
// from a minimal env rather than whatever the test shell happens to export.
const ENV_KEYS = [
  "WEEEK_ACCESS_TOKEN",
  "WEEEK_BASE_URL",
  "WEEEK_TIMEOUT_MS",
  "READ_ONLY",
  "ENABLED_TOOLS",
  "MAX_RESPONSE_CHARS",
] as const;

// The config the server boots with when only the required token is set — the
// single source of truth for every default the manifest advertises.
let defaults: EnvConfig;
beforeAll(() => {
  for (const k of ENV_KEYS) vi.stubEnv(k, undefined);
  vi.stubEnv("WEEEK_ACCESS_TOKEN", "x".repeat(32));
  defaults = loadConfig();
});
afterAll(() => {
  vi.unstubAllEnvs();
});

describe("server.json is a valid, pinned MCP registry manifest (#61)", () => {
  it("references the pinned schema version", () => {
    expect(manifest.$schema).toBe(PINNED_SCHEMA);
  });

  it("carries the three required top-level fields", () => {
    expect(manifest.name).toEqual(expect.any(String));
    expect(manifest.description).toEqual(expect.any(String));
    expect(manifest.version).toEqual(expect.any(String));
  });

  it("names a single npm stdio package", () => {
    expect(manifest.packages).toHaveLength(1);
    expect(npmPackage?.registryType).toBe("npm");
    expect(npmPackage?.transport.type).toBe("stdio");
  });

  it("restricts the npm registry to the allowlisted base URL", () => {
    // The official registry only accepts npm packages from npmjs.org; stating
    // it explicitly rather than relying on the default keeps the manifest
    // self-describing.
    expect(npmPackage?.registryBaseUrl).toBe("https://registry.npmjs.org");
  });
});

describe("manifest matches the package it describes (#61)", () => {
  it("uses a GitHub namespace name in the registry's format", () => {
    expect(manifest.name).toMatch(NAME_PATTERN);
    expect(manifest.name.startsWith("io.github.")).toBe(true);
  });

  it("spells the namespace exactly as repository.url spells the owner", () => {
    // Derived, not pinned — see the case note at the top of this file. Both
    // consumers of this spelling (the registry's HasPrefix grant check and
    // npm's provenance-vs-OIDC compare) are case-sensitive, and both read a
    // string that ultimately traces back to this repository's owner. Pinning
    // a literal here would go stale on a rename while still passing; deriving
    // it makes the rename fail loudly in exactly one place.
    const owner = new URL(pkg.repository.url).pathname.split("/")[1];
    expect(owner).toBeTruthy();
    expect(manifest.name).toBe(`io.github.${owner}/${pkg.name}`);
  });

  it("server.json name equals package.json mcpName — the registry's hard rule", () => {
    // The submission is rejected unless these are identical; a divergence here
    // is a submission that fails at the maintainer's terminal, days later.
    expect(manifest.name).toBe(pkg.mcpName);
  });

  it("advertises the real npm package identifier", () => {
    expect(npmPackage?.identifier).toBe(pkg.name);
  });

  it("keeps its description consistent with the package's", () => {
    expect(manifest.description).toBe(pkg.description);
  });

  it("points at the same repository as package.json, sans the git suffix", () => {
    expect(manifest.repository.source).toBe("github");
    expect(manifest.repository.url).toBe(pkg.repository.url.replace(/\.git$/, ""));
  });
});

describe("manifest version ratchets with the package (#61)", () => {
  // Not a literal pin: the whole point is that the `1.0.0` seal, which moves
  // `package.json`, must move the manifest with it. Three versions, one truth.
  it("top-level version equals package.json version", () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it("package version equals package.json version", () => {
    expect(npmPackage?.version).toBe(pkg.version);
  });

  it("the shared version is plain SemVer — no prerelease suffix", () => {
    expect(manifest.version).toMatch(SEMVER);
  });
});

describe("manifest describes the default read-only surface honestly (#61)", () => {
  it("every declared env var is a real one from src/config/env.ts", () => {
    // The manifest cannot invent an environment contract the server does not
    // honour: each name it advertises must appear in the config schema. Catches
    // a var renamed in `env.ts` but left stale in the manifest.
    const envSource = read("src/config/env.ts");
    for (const name of envByName.keys()) {
      expect(envSource.includes(name), `${name} absent from env.ts`).toBe(true);
    }
  });

  it("declares defaults that match the config's, not just the names", () => {
    // Names alone would let a default drift: `env.ts` lowers MAX_RESPONSE_CHARS
    // and the manifest keeps advertising the old number. Each defaulted var is
    // bound to what `loadConfig` actually applies, so a changed default fails
    // here rather than misleading an operator reading the registry entry.
    expect(envByName.get("WEEEK_BASE_URL")?.default).toBe(defaults.baseUrl);
    expect(envByName.get("WEEEK_TIMEOUT_MS")?.default).toBe(
      String(defaults.timeoutMs),
    );
    expect(envByName.get("MAX_RESPONSE_CHARS")?.default).toBe(
      String(defaults.maxResponseChars),
    );
    expect(envByName.get("READ_ONLY")?.default).toBe(
      defaults.readOnly ? "true" : "false",
    );
  });

  it("marks the access token required and secret", () => {
    const token = envByName.get("WEEEK_ACCESS_TOKEN");
    expect(token?.isRequired).toBe(true);
    expect(token?.isSecret).toBe(true);
  });

  it("defaults READ_ONLY to true, so a fresh install is read-only", () => {
    // The acceptance criterion in prose: a registry entry advertising the write
    // surface as the default would misrepresent what a fresh install does. This
    // pins the *literal* "true" as a product invariant, separate from the
    // consistency ratchet above — if the server's own default ever flipped to
    // false, that ratchet would still pass (manifest agrees with config) while
    // this one fails, which is the failure that should fire.
    const readOnly = envByName.get("READ_ONLY");
    expect(readOnly?.default).toBe("true");
    expect(readOnly?.isRequired ?? false).toBe(false);
  });

  it("frames writes as an explicit opt-in in the READ_ONLY description", () => {
    const readOnly = envByName.get("READ_ONLY");
    expect(readOnly?.description).toMatch(/opt-in/i);
    expect(readOnly?.description).toMatch(/write/i);
  });
});
