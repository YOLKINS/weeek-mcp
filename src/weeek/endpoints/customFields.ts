import type { WeeekClient } from "../client.js";
import { parseWeeekResponse } from "../unwrap.js";
import type { CustomFieldSummary } from "../types.js";
import { shapeField, shapeList } from "../shape.js";

// I8 (#47) — the workspace's custom-field DEFINITIONS.
//
// Read for exactly one purpose: turning an MR-link field's *name* into the
// UUID that keys the custom-fields write body (`setTaskMrLink`, ADR 0005 §3
// rung 1). It is deliberately not a tool — a custom-fields listing tool was
// declined in the scope lock (#9), and `POST /tm/custom-fields` (field
// creation) is never called from anywhere in this server.
//
// **The envelope key is `data`, not `customFields`.** The published spec
// documents this endpoint as an empty object (`{"type":"object",
// "properties":{}}`) with no per-id sibling; probe #12 found it actually
// answers `{success:true, data:[{id,name,type}, …]}`, which is what made
// by-name resolution viable at all. Tolerant inner shaping (ADR 0003) applies
// as everywhere else, so a renamed inner field degrades rather than erroring
// the write that depends on it.
const ENDPOINT = "list_custom_fields";

function customFieldFromJson(
  obj: Record<string, unknown>,
): CustomFieldSummary {
  return {
    // `string`, not `number`: this id is a UUID (probe #12). A drifted value
    // degrades to `""`, and the resolver drops any field whose id is empty —
    // writing to a `""` key would be a body Weeek accepts and ignores, which
    // is the exact failure mode this tool exists to avoid.
    id: shapeField({ endpoint: ENDPOINT, field: "id" }, { kind: "string", value: obj["id"] }),
    name: shapeField(
      { endpoint: ENDPOINT, field: "name" },
      { kind: "string", value: obj["name"] },
    ),
    type: shapeField(
      { endpoint: ENDPOINT, field: "type" },
      { kind: "string", value: obj["type"] },
    ),
  };
}

export async function listCustomFields(
  client: WeeekClient,
): Promise<CustomFieldSummary[]> {
  const raw = await client.request({
    method: "GET",
    path: "/tm/custom-fields",
  });
  const fields = parseWeeekResponse<unknown>(raw.status, raw.body, "data");
  // A present-but-non-array `data` degrades to `[]` — which the resolver then
  // reports as "no MR-link field is defined", the honest answer when the
  // listing carried nothing usable. A non-2xx (e.g. a plan-tier 403) is NOT
  // degraded: it throws from `parseWeeekResponse` above and reaches the agent
  // as the refusal it is.
  return shapeList({ endpoint: ENDPOINT }, fields, customFieldFromJson);
}
