import { describe, it, expect } from "vitest";
import {
  getMe,
  listProjects,
  getProject,
  listTasks,
  getTask,
  listBoards,
  listBoardColumns,
  listMembers,
  listTags,
} from "../../src/weeek/endpoints.js";
import type { BoardSummary } from "../../src/weeek/types.js";
import { tryLiveContext } from "./setup.js";

// One happy-path probe per read endpoint. Each `it` calls the real
// Weeek API and asserts the inner shape parses cleanly through the
// existing endpoint helper (which already runs strict zod / typeof
// validation on the upstream payload). Failures here mean either:
//   - the upstream API drifted (envelope key rename, field shape change)
//   - our endpoint helpers grew a regression
//
// Both should stop a release — but nothing here MAKES them. This comment
// used to claim that "`live-smoke.yml` runs on `push: tags: ['v*']` so a red
// live run blocks the publish", and that is false in both halves (corrected
// in 1.0.1): `live-smoke.yml` does fire on the tag, but `release.yml` is
// `workflow_dispatch`-only and reads no result from it, so the two never
// meet. The publish is gated on a human dispatching it. Read a red run here
// as a reason not to dispatch, not as a gate that already held.
//
// Nine probes cover the full read surface: the original six
// (`/user/me`, `/tm/projects`, `/tm/tasks`, `/tm/tasks/{id}`,
// `/ws/members`, `/tm/tags`) plus the I7 read-parity trio
// (`/tm/projects/{id}` G1, `/tm/boards` G2, `/tm/board-columns` G2).
// The three ID-scoped endpoints derive their input from a prior list
// probe and early-return on an empty workspace — same discipline as the
// `/tm/tasks/{id}` probe.

const ctx = tryLiveContext();

describe.skipIf(!ctx)("live: existing endpoints (token-gated)", () => {
  if (!ctx) return;
  const live = ctx;

  it("GET /user/me returns a parseable MeResponse", async () => {
    const me = await getMe(live.client);
    expect(me.email).toBeTypeOf("string");
    expect(me.email.length).toBeGreaterThan(0);
    expect(me.name).toBeTypeOf("string");
  });

  it("GET /tm/projects returns an array of project summaries", async () => {
    const projects = await listProjects(live.client);
    expect(Array.isArray(projects)).toBe(true);
    // We do not assume the workspace has any project; the parse itself
    // is the probe — an empty list is fine.
    for (const p of projects) {
      expect(typeof p.id).toBe("number");
      expect(typeof p.title).toBe("string");
    }
  });

  it("GET /tm/projects/{id} returns a parseable detail when at least one project exists", async () => {
    const projects = await listProjects(live.client);
    if (projects.length === 0) {
      // Empty workspaces are valid — no id to probe.
      return;
    }
    const first = projects[0]!;
    const detail = await getProject(live.client, first.id);
    expect(detail.id).toBe(first.id);
    expect(typeof detail.title).toBe("string");
    expect(detail.description === null || typeof detail.description === "string").toBe(true);
    expect(typeof detail.color).toBe("string");
    expect(typeof detail.isPrivate).toBe("boolean");
  });

  it("GET /tm/tasks (one default page) returns parseable summaries + hasMore", async () => {
    // Use the same default page size as the tool (D3: perPage=20) so this
    // probe matches the production code path.
    const result = await listTasks(live.client, { perPage: 20 });
    expect(Array.isArray(result.tasks)).toBe(true);
    expect(typeof result.hasMore).toBe("boolean");
  });

  it("GET /tm/tasks/{id} returns a parseable detail when at least one task exists", async () => {
    const page = await listTasks(live.client, { perPage: 1 });
    if (page.tasks.length === 0) {
      // Empty workspaces are valid — no probe to run.
      return;
    }
    const first = page.tasks[0]!;
    const detail = await getTask(live.client, first.id);
    expect(detail.id).toBe(first.id);
    expect(typeof detail.title).toBe("string");
    expect(detail.description === null || typeof detail.description === "string").toBe(true);
  });

  it("GET /tm/boards?projectId returns parseable boards when at least one project exists", async () => {
    const projects = await listProjects(live.client);
    if (projects.length === 0) {
      // No project → no projectId to scope the required query param.
      return;
    }
    const project = projects[0]!;
    const boards = await listBoards(live.client, project.id);
    expect(Array.isArray(boards)).toBe(true);
    // A project may have no boards; the parse itself is the probe.
    for (const b of boards) {
      expect(typeof b.id).toBe("number");
      expect(typeof b.name).toBe("string");
      expect(b.projectId).toBe(project.id);
      expect(typeof b.isPrivate).toBe("boolean");
    }
  });

  it("GET /tm/board-columns?boardId returns parseable columns when at least one board exists", async () => {
    const projects = await listProjects(live.client);
    if (projects.length === 0) return;
    // Walk projects until one yields a board; the columns endpoint needs a
    // real boardId and the first project is not guaranteed to have boards.
    let board: BoardSummary | undefined;
    for (const project of projects) {
      const boards = await listBoards(live.client, project.id);
      if (boards.length > 0) {
        board = boards[0]!;
        break;
      }
    }
    if (board === undefined) {
      // Workspace has projects but no boards — no boardId to probe.
      return;
    }
    const columns = await listBoardColumns(live.client, board.id);
    expect(Array.isArray(columns)).toBe(true);
    for (const c of columns) {
      expect(typeof c.id).toBe("number");
      expect(typeof c.name).toBe("string");
      expect(c.boardId).toBe(board.id);
    }
  });

  it("GET /ws/members returns string-id members", async () => {
    const members = await listMembers(live.client);
    expect(Array.isArray(members)).toBe(true);
    for (const m of members) {
      expect(typeof m.id).toBe("string");
      expect(typeof m.email).toBe("string");
    }
  });

  it("GET /tm/tags returns parseable tag summaries", async () => {
    const tags = await listTags(live.client);
    expect(Array.isArray(tags)).toBe(true);
    for (const t of tags) {
      expect(typeof t.id).toBe("number");
      expect(typeof t.title).toBe("string");
    }
  });
});
