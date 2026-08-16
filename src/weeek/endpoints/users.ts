import type { WeeekClient } from "../client.js";
import { parseWeeekResponse } from "../unwrap.js";
import type { MeResponse } from "../types.js";
import { shapeField } from "../shape.js";
import { asJson, invalid } from "./shared.js";

// I7.5 (#37) — `weeek_get_me` reads its inner fields tolerantly through
// `shapeField`, but its two special semantics survive the migration intact
// (that is the whole point of this special-case ticket):
//
//  1. `id` is a `number | string` union — Weeek is inconsistent about the JSON
//     type. A real number or string passes through *untouched*; the union is
//     never collapsed into a single family. Only a value that is neither
//     degrades, via `shapeField`'s number path, to `0` (warned once as
//     `get_me:id`) — the accepted degraded-primary-key sharp edge (ADR 0003).
//  2. `name` is *derived*, not a wire field: explicit `name` → firstName +
//     lastName → email. The inputs (`firstName` / `lastName` / `name`) are read
//     defensively as nullable strings, so a drifted one degrades to `null` and
//     drops out of the fallback chain rather than throwing.
//
// A non-object resource still hard-throws: a detail cannot "drop" the way a list
// entry can, and a fully-synthetic all-defaults record would look successful but
// be garbage (ADR 0003, matching #34/#36). No *inner-field* drift can throw, so a
// working credential with a drifted cosmetic field never regresses to
// `weeek_invalid_response`.
const ENDPOINT = "get_me";

export async function getMe(client: WeeekClient): Promise<MeResponse> {
  const raw = await client.request({ method: "GET", path: "/user/me" });
  const user = parseWeeekResponse<unknown>(raw.status, raw.body, "user");
  const obj = asJson(user);
  if (obj === undefined) {
    throw invalid(raw.status, "weeek /user/me payload not an object");
  }

  // Preserve the `number | string` union: a real id passes through as-is. Only a
  // drifted (neither-number-nor-string) id falls through to the number path,
  // which warns and yields `0`. Short-circuiting first keeps a valid string id
  // from spuriously warning.
  const rawId = obj["id"];
  const id: number | string =
    typeof rawId === "number" && Number.isFinite(rawId)
      ? rawId
      : typeof rawId === "string"
        ? rawId
        : shapeField(
            { endpoint: ENDPOINT, field: "id" },
            { kind: "number", value: rawId },
          );

  const email = shapeField(
    { endpoint: ENDPOINT, field: "email" },
    { kind: "string", value: obj["email"] },
  );

  // Weeek /user/me returns firstName/lastName/middleName, not a single `name`.
  // We derive a display name and fall back to the email so a working credential
  // never surfaces as `weeek_invalid_response`. See docs/weeek-api-notes.md
  // (closes I3-M2). Each derivation input is nullable-shaped: a drift degrades to
  // `null` and simply drops out of the chain.
  const firstName = shapeField(
    { endpoint: ENDPOINT, field: "firstName" },
    { kind: "nullable", of: "string", value: obj["firstName"] },
  );
  const lastName = shapeField(
    { endpoint: ENDPOINT, field: "lastName" },
    { kind: "nullable", of: "string", value: obj["lastName"] },
  );
  const explicitName = shapeField(
    { endpoint: ENDPOINT, field: "name" },
    { kind: "nullable", of: "string", value: obj["name"] },
  );

  const parts: string[] = [];
  if (firstName !== null && firstName.length > 0) parts.push(firstName);
  if (lastName !== null && lastName.length > 0) parts.push(lastName);
  const derived = parts.join(" ").trim();
  const name =
    explicitName !== null && explicitName.length > 0
      ? explicitName
      : derived.length > 0
        ? derived
        : email;

  return { id, email, name };
}
