import type { WeeekClient } from "../client.js";
import { parseWeeekResponse } from "../unwrap.js";
import type { TagSummary } from "../types.js";
import { shapeField, shapeList } from "../shape.js";

// I7.5 (#35) — inner fields shaped tolerantly (`id` → `0`, `title`/`color` →
// `""`); no inner-field drift throws (ADR 0003). RETRO-22: a drifted `id`
// degrades to `0` by design (the contract is loose — Weeek may renumber), not
// a strictness gap to tighten.
const ENDPOINT = "list_tags";

function tagFromJson(obj: Record<string, unknown>): TagSummary {
  return {
    id: shapeField({ endpoint: ENDPOINT, field: "id" }, { kind: "number", value: obj["id"] }),
    title: shapeField(
      { endpoint: ENDPOINT, field: "title" },
      { kind: "string", value: obj["title"] },
    ),
    color: shapeField(
      { endpoint: ENDPOINT, field: "color" },
      { kind: "string", value: obj["color"] },
    ),
  };
}

export async function listTags(client: WeeekClient): Promise<TagSummary[]> {
  const raw = await client.request({ method: "GET", path: "/ws/tags" });
  const tags = parseWeeekResponse<unknown>(raw.status, raw.body, "tags");
  // A present-but-non-array `tags`, or a non-object entry, degrades to `[]` /
  // a dropped row rather than throwing.
  return shapeList({ endpoint: ENDPOINT }, tags, tagFromJson);
}
