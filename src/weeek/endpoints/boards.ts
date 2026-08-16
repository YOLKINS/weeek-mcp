import type { WeeekClient } from "../client.js";
import { parseWeeekResponse } from "../unwrap.js";
import type { BoardSummary } from "../types.js";
import { shapeField, shapeList } from "../shape.js";

// I7.5 (#34) — inner fields shaped tolerantly (`id`/`projectId` → `0`,
// `name` → `""`, `isPrivate` → `false`); no inner-field drift throws (ADR 0003).
const ENDPOINT = "list_boards";

function boardFromJson(obj: Record<string, unknown>): BoardSummary {
  return {
    id: shapeField({ endpoint: ENDPOINT, field: "id" }, { kind: "number", value: obj["id"] }),
    name: shapeField({ endpoint: ENDPOINT, field: "name" }, { kind: "string", value: obj["name"] }),
    projectId: shapeField(
      { endpoint: ENDPOINT, field: "projectId" },
      { kind: "number", value: obj["projectId"] },
    ),
    isPrivate: shapeField(
      { endpoint: ENDPOINT, field: "isPrivate" },
      { kind: "boolean", value: obj["isPrivate"] },
    ),
  };
}

// `/tm/boards` requires `projectId` as a query parameter; calling without it
// returns HTTP 422 (probe-confirmed 2026-05-13). The tool's Zod input layer
// enforces this so the agent never sees the 422.
export async function listBoards(
  client: WeeekClient,
  projectId: number,
): Promise<BoardSummary[]> {
  const params = new URLSearchParams();
  params.set("projectId", String(projectId));
  const raw = await client.request({
    method: "GET",
    path: `/tm/boards?${params.toString()}`,
  });
  const boards = parseWeeekResponse<unknown>(raw.status, raw.body, "boards");
  // A present-but-non-array `boards`, or a non-object entry, degrades to `[]` /
  // a dropped row rather than throwing.
  return shapeList({ endpoint: ENDPOINT }, boards, boardFromJson);
}
