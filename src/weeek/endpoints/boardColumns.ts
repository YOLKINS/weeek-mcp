import type { WeeekClient } from "../client.js";
import { parseWeeekResponse } from "../unwrap.js";
import type { BoardColumnSummary } from "../types.js";
import { shapeField, shapeList } from "../shape.js";

// I7.5 (#34) — inner fields shaped tolerantly (`id`/`boardId` → `0`,
// `name` → `""`); no inner-field drift throws (ADR 0003).
const ENDPOINT = "list_board_columns";

function boardColumnFromJson(obj: Record<string, unknown>): BoardColumnSummary {
  return {
    id: shapeField({ endpoint: ENDPOINT, field: "id" }, { kind: "number", value: obj["id"] }),
    name: shapeField({ endpoint: ENDPOINT, field: "name" }, { kind: "string", value: obj["name"] }),
    boardId: shapeField(
      { endpoint: ENDPOINT, field: "boardId" },
      { kind: "number", value: obj["boardId"] },
    ),
  };
}

// Path is hyphenated `/tm/board-columns`, not `/tm/boards/{id}/columns`
// (probe-confirmed 2026-05-13). `boardId` is a required query parameter;
// unknown boardId returns 422 with `{success:false, errors:{boardId:[...]}}`,
// surfaced through `unwrap.codeForStatus` as `weeek_invalid_response`.
// Upstream array order is the only sort signal and is preserved verbatim.
export async function listBoardColumns(
  client: WeeekClient,
  boardId: number,
): Promise<BoardColumnSummary[]> {
  const params = new URLSearchParams();
  params.set("boardId", String(boardId));
  const raw = await client.request({
    method: "GET",
    path: `/tm/board-columns?${params.toString()}`,
  });
  const columns = parseWeeekResponse<unknown>(
    raw.status,
    raw.body,
    "boardColumns",
  );
  // A present-but-non-array `boardColumns`, or a non-object entry, degrades to
  // `[]` / a dropped row rather than throwing.
  return shapeList({ endpoint: ENDPOINT }, columns, boardColumnFromJson);
}
