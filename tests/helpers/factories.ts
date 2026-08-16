import type { EnvConfig } from "../../src/config/env.js";
import type { SuccessPayload } from "../../src/tools/_response-limits.js";

export function makeEnvConfig(overrides: Partial<EnvConfig> = {}): EnvConfig {
  return {
    accessToken: "x".repeat(32),
    baseUrl: "https://api.weeek.net/public/v1",
    timeoutMs: 30000,
    readOnly: true,
    enabledTools: undefined,
    maxResponseChars: 65536,
    ...overrides,
  };
}

export function makeSuccessPayload<S extends Record<string, unknown>>(
  structured: S,
  text = "ok",
): SuccessPayload<S> {
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
  };
}

// Raw JSON payloads — match what Weeek API returns. Used in endpoint tests
// (parsed via parseWeeekResponse) and as the `body` field of mocked
// WeeekClient.request responses in tool tests. Each factory returns the
// minimum shape; overrides allow tests to add or mutate fields per-case.

export function makeUserPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1,
    email: "anna@example.com",
    firstName: "Anna",
    lastName: "Pak",
    ...overrides,
  };
}

export function makeProjectPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1,
    title: "Alpha",
    color: "#fff",
    isPrivate: false,
    ...overrides,
  };
}

export function makeProjectDetailPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1,
    title: "Alpha",
    description: "details",
    color: "#fff",
    isPrivate: false,
    ...overrides,
  };
}

// UUID-shape fixture id matching `/ws/members.id` / `/tm/projects.team[]`
// — probe-confirmed format for `userId` and `assignees` on Task* shapes.
const FIXTURE_MEMBER_UUID = "f47ac10b-58cc-4372-a567-000000000001" as const;

// Bug #25 (spec #26, ticket A): the real Weeek task object carries the
// completion flag under `isCompleted` (there is no `completed` key) and
// returns `priority: null` for unprioritised tasks. These factories emit
// that real upstream shape so a green mocked suite means the parser handles
// real data. The numeric-priority default (`priority: 1`) is the common
// "priority set" case; the `priority: null` variant is produced by override
// (`makeTaskSummaryPayload({ priority: null })`) and exercised in the
// endpoint regression tests.
export function makeTaskSummaryPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1,
    title: "Task one",
    isCompleted: false,
    projectId: 5,
    priority: 1,
    type: "action",
    userId: FIXTURE_MEMBER_UUID,
    assignees: [FIXTURE_MEMBER_UUID],
    ...overrides,
  };
}

export function makeTaskDetailPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1,
    title: "Task one",
    description: "details",
    isCompleted: false,
    projectId: 5,
    priority: 1,
    type: "action",
    userId: FIXTURE_MEMBER_UUID,
    assignees: [FIXTURE_MEMBER_UUID],
    ...overrides,
  };
}

export function makeBoardPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1,
    name: "Board one",
    projectId: 5,
    isPrivate: false,
    ...overrides,
  };
}

export function makeBoardColumnPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1,
    name: "Column one",
    boardId: 7,
    ...overrides,
  };
}

export function makeMemberPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "u-1",
    email: "member@example.com",
    firstName: "Mem",
    lastName: "Ber",
    ...overrides,
  };
}

// I8 (#47) — a `/tm/custom-fields` row. The `id` is a **UUID string**, not the
// integer used for board / column / project ids (probe #12), so the fixture
// carries a real UUID: a test that passed with `id: 1` would prove nothing
// about the shape the tool actually has to write.
export const FIXTURE_MR_FIELD_UUID =
  "3f6c1b2a-0d4e-4a71-9c33-000000000042" as const;

export function makeCustomFieldPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: FIXTURE_MR_FIELD_UUID,
    name: "MR link",
    type: "link",
    ...overrides,
  };
}

export function makeTagPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1,
    title: "important",
    color: "#abc",
    ...overrides,
  };
}

// Wraps any value into the {success:true, <key>: value} envelope Weeek
// returns on 2xx. Sibling keys (like `hasMore` for /tm/tasks) can be
// merged on top of the result via spread.
export function makeEnvelope(
  key: string,
  value: unknown,
): { success: true; [k: string]: unknown } {
  return { success: true, [key]: value };
}
