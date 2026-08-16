import type { WeeekClient } from "../client.js";
import { parseWeeekResponse } from "../unwrap.js";
import type { ProjectDetail } from "../types.js";
import { shapeField } from "../shape.js";
import { asJson, invalid } from "./shared.js";

// I7.5 (#34) — inner fields shaped tolerantly: `id` → `0`, `title` / `color` →
// `""`, `isPrivate` → `false`, and the nullable `description` → `null`. No
// inner-field drift can throw (ADR 0003).
const ENDPOINT = "get_project";

function projectDetailFromJson(status: number, raw: unknown): ProjectDetail {
  const obj = asJson(raw);
  // The whole resource being a non-object (e.g. an array — arrays clear the
  // envelope's `typeof === "object"` gate) stays a hard error: a detail cannot
  // "drop" the way a list entry can, and emitting a fully-synthetic all-defaults
  // record would hand the agent garbage that looks successful (ADR 0003 rejects
  // synthetic all-defaults rows). Individual *fields* below still degrade.
  if (obj === undefined) {
    throw invalid(status, "weeek project entry not an object");
  }
  return {
    id: shapeField({ endpoint: ENDPOINT, field: "id" }, { kind: "number", value: obj["id"] }),
    title: shapeField({ endpoint: ENDPOINT, field: "title" }, { kind: "string", value: obj["title"] }),
    description: shapeField(
      { endpoint: ENDPOINT, field: "description" },
      { kind: "nullable", of: "string", value: obj["description"] },
    ),
    color: shapeField({ endpoint: ENDPOINT, field: "color" }, { kind: "string", value: obj["color"] }),
    isPrivate: shapeField(
      { endpoint: ENDPOINT, field: "isPrivate" },
      { kind: "boolean", value: obj["isPrivate"] },
    ),
  };
}

export async function getProject(
  client: WeeekClient,
  id: number,
): Promise<ProjectDetail> {
  const raw = await client.request({
    method: "GET",
    path: `/tm/projects/${String(id)}`,
  });
  const project = parseWeeekResponse<unknown>(raw.status, raw.body, "project");
  return projectDetailFromJson(raw.status, project);
}
