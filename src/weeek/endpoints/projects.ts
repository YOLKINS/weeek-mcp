import type { WeeekClient } from "../client.js";
import { parseWeeekResponse } from "../unwrap.js";
import type { ProjectSummary } from "../types.js";
import { shapeField, shapeList } from "../shape.js";

// I7.5 (#34) — inner fields shaped tolerantly: a drifted `id` → `0`, a drifted
// `title` / `color` → `""`, a drifted `isPrivate` → `false`, each warned once
// per `endpoint:field`. No inner-field drift can throw (ADR 0003).
const ENDPOINT = "list_projects";

function projectFromJson(obj: Record<string, unknown>): ProjectSummary {
  return {
    id: shapeField({ endpoint: ENDPOINT, field: "id" }, { kind: "number", value: obj["id"] }),
    title: shapeField({ endpoint: ENDPOINT, field: "title" }, { kind: "string", value: obj["title"] }),
    color: shapeField({ endpoint: ENDPOINT, field: "color" }, { kind: "string", value: obj["color"] }),
    isPrivate: shapeField(
      { endpoint: ENDPOINT, field: "isPrivate" },
      { kind: "boolean", value: obj["isPrivate"] },
    ),
  };
}

export async function listProjects(
  client: WeeekClient,
): Promise<ProjectSummary[]> {
  const raw = await client.request({ method: "GET", path: "/tm/projects" });
  const projects = parseWeeekResponse<unknown>(raw.status, raw.body, "projects");
  // A present-but-non-array `projects`, or a non-object entry, degrades instead
  // of throwing (the envelope already proved `projects` is present).
  return shapeList({ endpoint: ENDPOINT }, projects, projectFromJson);
}
