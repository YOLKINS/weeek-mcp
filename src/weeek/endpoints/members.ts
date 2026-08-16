import type { WeeekClient } from "../client.js";
import { parseWeeekResponse } from "../unwrap.js";
import type { MemberSummary } from "../types.js";
import { shapeField, shapeList } from "../shape.js";

// I7.5 (#35) — inner fields shaped tolerantly. `id` is a *string* here (Weeek
// treats members differently from tasks/projects), so a drifted `id` degrades
// to `""` — the accepted degraded-primary-key sharp edge (ADR 0003). Nullable
// `firstName`/`lastName` stay `null` when legitimately absent and degrade to
// `null` on a present-but-wrong-typed value. No inner-field drift throws.
const ENDPOINT = "list_members";

function memberFromJson(obj: Record<string, unknown>): MemberSummary {
  return {
    id: shapeField({ endpoint: ENDPOINT, field: "id" }, { kind: "string", value: obj["id"] }),
    email: shapeField(
      { endpoint: ENDPOINT, field: "email" },
      { kind: "string", value: obj["email"] },
    ),
    firstName: shapeField(
      { endpoint: ENDPOINT, field: "firstName" },
      { kind: "nullable", of: "string", value: obj["firstName"] },
    ),
    lastName: shapeField(
      { endpoint: ENDPOINT, field: "lastName" },
      { kind: "nullable", of: "string", value: obj["lastName"] },
    ),
  };
}

export async function listMembers(
  client: WeeekClient,
): Promise<MemberSummary[]> {
  const raw = await client.request({ method: "GET", path: "/ws/members" });
  const members = parseWeeekResponse<unknown>(raw.status, raw.body, "members");
  // A present-but-non-array `members`, or a non-object entry, degrades to `[]` /
  // a dropped row rather than throwing.
  return shapeList({ endpoint: ENDPOINT }, members, memberFromJson);
}
