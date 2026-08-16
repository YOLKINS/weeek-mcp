import { describe, it, expect } from "vitest";
import { listTasks, getTask } from "../../../src/weeek/endpoints/tasks.js";
import { WeeekError } from "../../../src/weeek/types.js";
import { makeMockWeeekClient } from "../../helpers/mockWeeekClient.js";
import {
  makeEnvelope,
  makeTaskSummaryPayload,
  makeTaskDetailPayload,
} from "../../helpers/factories.js";
import { silenceShapeWarn } from "../../helpers/shapeWarn.js";
import { WEEEK_PATH } from "../../helpers/paths.js";

// I7.5 (#36): the task parsers read through `shapeField` / `shapeList`, so an
// inner-field drift degrades to a schema-valid default instead of throwing. The
// tolerant-shaping warn is silenced and its per-process dedup reset per case.
silenceShapeWarn();

describe("listTasks — request encoding & envelope", () => {
  it("happy path with no args hits /tm/tasks (no querystring)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.tasksList, {
      status: 200,
      body: { ...makeEnvelope("tasks", []), hasMore: false },
    });
    const out = await listTasks(m.client, {});
    expect(out).toEqual({ tasks: [], hasMore: false });
    const reqs = m.requests();
    expect(reqs[0]?.path).toBe(WEEEK_PATH.tasksList);
  });

  it("encodes all args into the querystring in the documented order", async () => {
    const m = makeMockWeeekClient();
    m.setDefault({
      status: 200,
      body: makeEnvelope("tasks", []),
    });
    await listTasks(m.client, {
      projectId: 5,
      completed: true,
      offset: 10,
      perPage: 20,
    });
    const reqs = m.requests();
    expect(reqs[0]?.path).toBe(
      `${WEEEK_PATH.tasksList}?projectId=5&completed=1&offset=10&perPage=20`,
    );
  });

  // Bug #25 / #28 (Bug 3): the live API validates `completed` as a Laravel
  // boolean — `1`/`0` accepted, the JS `String(bool)` form (`true`/`false`)
  // rejected with HTTP 422 — so the old serialization never filtered. These
  // two tests pin the corrected `1`/`0` encoding; the full probe write-up
  // lives in `docs/weeek-api-notes.md` and `src/weeek/endpoints/tasks.ts`.
  it("completed=true serializes as '1' (Laravel boolean, not String(true))", async () => {
    const m = makeMockWeeekClient();
    m.setDefault({ status: 200, body: makeEnvelope("tasks", []) });
    await listTasks(m.client, { completed: true });
    expect(m.requests()[0]?.path).toBe(`${WEEEK_PATH.tasksList}?completed=1`);
  });

  it("completed=false serializes as '0' (Laravel boolean, not String(false))", async () => {
    const m = makeMockWeeekClient();
    m.setDefault({ status: 200, body: makeEnvelope("tasks", []) });
    await listTasks(m.client, { completed: false });
    expect(m.requests()[0]?.path).toBe(`${WEEEK_PATH.tasksList}?completed=0`);
  });

  // #48 — the bounded location filters. Live-probed 2026-07-22 against the
  // sandbox workspace: `?boardId=1` → {1,2,53}, `?boardColumnId=1` → {1,2},
  // `?boardColumnId=2` → {53}, and the two AND together with `projectId` /
  // `completed`. An id that does not exist is a **422**, not an empty page.
  it("boardId serializes to the upstream boardId query parameter", async () => {
    const m = makeMockWeeekClient();
    m.setDefault({ status: 200, body: makeEnvelope("tasks", []) });
    await listTasks(m.client, { boardId: 7 });
    expect(m.requests()[0]?.path).toBe(`${WEEEK_PATH.tasksList}?boardId=7`);
  });

  it("boardColumnId serializes to the upstream boardColumnId query parameter", async () => {
    const m = makeMockWeeekClient();
    m.setDefault({ status: 200, body: makeEnvelope("tasks", []) });
    await listTasks(m.client, { boardColumnId: 3 });
    expect(m.requests()[0]?.path).toBe(
      `${WEEEK_PATH.tasksList}?boardColumnId=3`,
    );
  });

  it("board filters compose with the project and completion filters", async () => {
    const m = makeMockWeeekClient();
    m.setDefault({ status: 200, body: makeEnvelope("tasks", []) });
    await listTasks(m.client, {
      projectId: 1,
      boardId: 7,
      boardColumnId: 3,
      completed: false,
      offset: 10,
      perPage: 20,
    });
    expect(m.requests()[0]?.path).toBe(
      `${WEEEK_PATH.tasksList}?projectId=1&boardId=7&boardColumnId=3&completed=0&offset=10&perPage=20`,
    );
  });

  // The assignee filter's transport half (#48). The tool-side input — and its
  // description, which cannot be written until the primary-vs-any-assignee
  // probe runs — lands separately; the wire mapping is probe-confirmed
  // already: `?userId=<member uuid>` narrows (it excludes an unassigned task)
  // and a UUID that is not a member of the workspace is a 422.
  it("assigneeId serializes to the upstream userId query parameter", async () => {
    const m = makeMockWeeekClient();
    m.setDefault({ status: 200, body: makeEnvelope("tasks", []) });
    await listTasks(m.client, {
      assigneeId: "f47ac10b-58cc-4372-a567-deadbeef0003",
    });
    expect(m.requests()[0]?.path).toBe(
      `${WEEEK_PATH.tasksList}?userId=f47ac10b-58cc-4372-a567-deadbeef0003`,
    );
  });

  it("the assignee filter composes with the location and completion filters", async () => {
    const m = makeMockWeeekClient();
    m.setDefault({ status: 200, body: makeEnvelope("tasks", []) });
    await listTasks(m.client, {
      projectId: 1,
      boardId: 7,
      boardColumnId: 3,
      assigneeId: "f47ac10b-58cc-4372-a567-deadbeef0003",
      completed: false,
      perPage: 20,
    });
    expect(m.requests()[0]?.path).toBe(
      `${WEEEK_PATH.tasksList}?projectId=1&boardId=7&boardColumnId=3` +
        `&userId=f47ac10b-58cc-4372-a567-deadbeef0003&completed=0&perPage=20`,
    );
  });

  it("an omitted board filter contributes no query parameter at all", async () => {
    const m = makeMockWeeekClient();
    m.setDefault({ status: 200, body: makeEnvelope("tasks", []) });
    await listTasks(m.client, { projectId: 1 });
    const path = m.requests()[0]?.path ?? "";
    expect(path).toBe(`${WEEEK_PATH.tasksList}?projectId=1`);
    expect(path).not.toContain("boardId");
    expect(path).not.toContain("boardColumnId");
  });

  it("hasMore=true sibling envelope key surfaces in the result", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.tasksList, {
      status: 200,
      body: { ...makeEnvelope("tasks", []), hasMore: true },
    });
    const out = await listTasks(m.client, {});
    expect(out.hasMore).toBe(true);
  });

  it("hasMore absent → result.hasMore=false", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.tasksList, {
      status: 200,
      body: makeEnvelope("tasks", []),
    });
    const out = await listTasks(m.client, {});
    expect(out.hasMore).toBe(false);
  });
});

// --- I7.5 (#36) tolerant shaping: inner-field / container drift degrades,
// never throws — while the envelope stays strict.
describe("listTasks — tolerant shaping (#36)", () => {
  it("present-but-non-array `tasks` degrades to [] (no throw)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.tasksList, {
      status: 200,
      body: makeEnvelope("tasks", { not: "array" }),
    });
    const out = await listTasks(m.client, {});
    expect(out).toEqual({ tasks: [], hasMore: false });
  });

  it("a missing `priority` degrades to null (no throw)", async () => {
    const broken = makeTaskSummaryPayload();
    delete broken["priority"];
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.tasksList, {
      status: 200,
      body: makeEnvelope("tasks", [broken]),
    });
    const out = await listTasks(m.client, {});
    expect(out.tasks[0]?.priority).toBeNull();
  });

  it("Gate F: every wrong-typed summary field degrades to its typed default", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.tasksList, {
      status: 200,
      body: makeEnvelope("tasks", [
        makeTaskSummaryPayload({
          id: "x",
          title: 42,
          isCompleted: "no",
          projectId: null,
          priority: "high",
          type: 99,
          userId: 7,
          assignees: "nope",
        }),
      ]),
    });
    const out = await listTasks(m.client, {});
    expect(out.tasks).toEqual([
      {
        id: 0,
        title: "",
        completed: false,
        projectId: 0,
        priority: null,
        type: "",
        userId: null,
        assignees: [],
      },
    ]);
  });

  // THE regression this increment closes: the old `.map(throwingParser)` blew
  // up the whole list on a single drifted row. A drifted middle row must now
  // degrade in place while its siblings survive intact.
  it("one drifted row leaves the other rows intact (the .map()-throws regression is gone)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.tasksList, {
      status: 200,
      body: makeEnvelope("tasks", [
        makeTaskSummaryPayload({ id: 1, title: "keep-1" }),
        makeTaskSummaryPayload({ id: 2, title: 42 }), // drifted title
        makeTaskSummaryPayload({ id: 3, title: "keep-3" }),
      ]),
    });
    const out = await listTasks(m.client, {});
    expect(out.tasks.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(out.tasks.map((t) => t.title)).toEqual(["keep-1", "", "keep-3"]);
  });

  it("drops a non-object entry, keeping its siblings", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.tasksList, {
      status: 200,
      body: makeEnvelope("tasks", [
        makeTaskSummaryPayload({ id: 1 }),
        "not-an-object",
        makeTaskSummaryPayload({ id: 3 }),
      ]),
    });
    const out = await listTasks(m.client, {});
    expect(out.tasks.map((t) => t.id)).toEqual([1, 3]);
  });

  it("envelope negatives still throw (success:false)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.tasksList, {
      status: 200,
      body: { success: false },
    });
    await expect(listTasks(m.client, {})).rejects.toBeInstanceOf(WeeekError);
  });
});

describe("getTask — happy & not-found", () => {
  it("happy: hits /tm/tasks/{id} and returns a TaskDetail", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.taskById(42), {
      status: 200,
      body: makeEnvelope(
        "task",
        makeTaskDetailPayload({ id: 42, title: "answer" }),
      ),
    });
    const out = await getTask(m.client, 42);
    expect(out.id).toBe(42);
    expect(out.title).toBe("answer");
    expect(out.description).toBe("details");
    // Default factory ships UUID-shape userId/assignees (session B).
    expect(typeof out.userId).toBe("string");
    expect(Array.isArray(out.assignees)).toBe(true);
  });

  it("description: null is preserved", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.taskById(1), {
      status: 200,
      body: makeEnvelope(
        "task",
        makeTaskDetailPayload({ id: 1, description: null }),
      ),
    });
    const out = await getTask(m.client, 1);
    expect(out.description).toBeNull();
  });

  it("description: string is preserved verbatim", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.taskById(1), {
      status: 200,
      body: makeEnvelope(
        "task",
        makeTaskDetailPayload({ id: 1, description: "long text" }),
      ),
    });
    const out = await getTask(m.client, 1);
    expect(out.description).toBe("long text");
  });

  it("404 maps to WeeekError(weeek_not_found)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.taskById(99), { status: 404, body: {} });
    let err: unknown;
    try {
      await getTask(m.client, 99);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WeeekError);
    expect((err as WeeekError).code).toBe("weeek_not_found");
  });
});

describe("getTask — tolerant shaping (#36)", () => {
  it("a missing `title` degrades to \"\" (no throw)", async () => {
    const broken = makeTaskDetailPayload();
    delete broken["title"];
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.taskById(1), {
      status: 200,
      body: makeEnvelope("task", broken),
    });
    const out = await getTask(m.client, 1);
    expect(out.title).toBe("");
  });

  it("Gate F: every wrong-typed detail field degrades to its typed default", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.taskById(1), {
      status: 200,
      body: makeEnvelope(
        "task",
        makeTaskDetailPayload({
          id: "x",
          title: 42,
          description: 123,
          isCompleted: "no",
          projectId: null,
          priority: "high",
          type: 99,
          userId: 7,
          assignees: "nope",
        }),
      ),
    });
    const out = await getTask(m.client, 1);
    expect(out).toEqual({
      id: 0,
      title: "",
      description: null,
      completed: false,
      projectId: 0,
      priority: null,
      type: "",
      userId: null,
      assignees: [],
    });
  });

  // A detail resource cannot "drop" a row the way a list entry can — a
  // fully-synthetic all-defaults task would look successful but be garbage
  // (ADR 0003), so a non-object detail stays a hard error.
  it("a non-object detail resource still throws (arrays clear the envelope gate)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.taskById(1), {
      status: 200,
      body: makeEnvelope("task", ["not", "an", "object"]),
    });
    await expect(getTask(m.client, 1)).rejects.toBeInstanceOf(WeeekError);
  });

  it("envelope negatives still throw (success:false)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.taskById(1), {
      status: 200,
      body: { success: false },
    });
    await expect(getTask(m.client, 1)).rejects.toBeInstanceOf(WeeekError);
  });
});

describe("task-shape regression (bug #25 — isCompleted + nullable priority)", () => {
  // Bug 1: the real Weeek task carries the completion flag under
  // `isCompleted` (no `completed` key). The parser reads `isCompleted` and
  // exposes it under the stable normalized output name `completed`.
  it("summary: isCompleted maps to the normalized `completed` output field", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.tasksList, {
      status: 200,
      body: makeEnvelope("tasks", [
        makeTaskSummaryPayload({ id: 1, isCompleted: true }),
      ]),
    });
    const out = await listTasks(m.client, {});
    expect(out.tasks[0]?.completed).toBe(true);
  });

  it("detail: isCompleted maps to the normalized `completed` output field", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.taskById(1), {
      status: 200,
      body: makeEnvelope("task", makeTaskDetailPayload({ isCompleted: true })),
    });
    const out = await getTask(m.client, 1);
    expect(out.completed).toBe(true);
  });

  it("absent isCompleted degrades to false (no throw)", async () => {
    const broken = makeTaskSummaryPayload();
    delete broken["isCompleted"];
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.tasksList, {
      status: 200,
      body: makeEnvelope("tasks", [broken]),
    });
    const out = await listTasks(m.client, {});
    expect(out.tasks[0]?.completed).toBe(false);
  });

  it("non-boolean isCompleted degrades to false; a stray legacy `completed` does NOT rescue it", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.taskById(1), {
      status: 200,
      body: makeEnvelope(
        "task",
        // The read is strictly `isCompleted`: a non-boolean value degrades to
        // `false`, and a stray legacy `completed: true` must NOT rescue it.
        makeTaskDetailPayload({ isCompleted: 1, completed: true }),
      ),
    });
    const out = await getTask(m.client, 1);
    expect(out.completed).toBe(false);
  });

  // Bug 2: unprioritised tasks come back as `priority: null`; the parser
  // passes null through instead of rejecting the whole call.
  it("summary: priority null parses to null (not a throw)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.tasksList, {
      status: 200,
      body: makeEnvelope("tasks", [
        makeTaskSummaryPayload({ id: 1, priority: null }),
      ]),
    });
    const out = await listTasks(m.client, {});
    expect(out.tasks[0]?.priority).toBeNull();
  });

  it("detail: priority null parses to null (not a throw)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.taskById(1), {
      status: 200,
      body: makeEnvelope("task", makeTaskDetailPayload({ priority: null })),
    });
    const out = await getTask(m.client, 1);
    expect(out.priority).toBeNull();
  });

  it("numeric priority still passes through unchanged", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.taskById(1), {
      status: 200,
      body: makeEnvelope("task", makeTaskDetailPayload({ priority: 2 })),
    });
    const out = await getTask(m.client, 1);
    expect(out.priority).toBe(2);
  });

  it("non-numeric, non-null priority degrades to null (no throw)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.taskById(1), {
      status: 200,
      body: makeEnvelope("task", makeTaskDetailPayload({ priority: "high" })),
    });
    const out = await getTask(m.client, 1);
    expect(out.priority).toBeNull();
  });
});

describe("multi-assignee parsing (I7 BREAK, tolerant #36)", () => {
  // Probe-confirmed shape: `userId: string|null`, `assignees: string[]`
  // (UUID format). Tolerant on absence (null / []) AND on drift: a wrong-typed
  // userId → null, a non-array or bad-element assignees → [] (no throw, no
  // placeholder "" id).
  it("userId: UUID string is mapped verbatim", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.taskById(1), {
      status: 200,
      body: makeEnvelope(
        "task",
        makeTaskDetailPayload({
          userId: "f47ac10b-58cc-4372-a567-deadbeef0001",
        }),
      ),
    });
    const out = await getTask(m.client, 1);
    expect(out.userId).toBe("f47ac10b-58cc-4372-a567-deadbeef0001");
  });

  it("userId: null is preserved (unassigned task)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.taskById(1), {
      status: 200,
      body: makeEnvelope("task", makeTaskDetailPayload({ userId: null })),
    });
    const out = await getTask(m.client, 1);
    expect(out.userId).toBeNull();
  });

  it("userId missing → null (absence is not drift)", async () => {
    const broken = makeTaskDetailPayload();
    delete broken["userId"];
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.taskById(1), {
      status: 200,
      body: makeEnvelope("task", broken),
    });
    const out = await getTask(m.client, 1);
    expect(out.userId).toBeNull();
  });

  it("userId: 42 (numeric) degrades to null (no coerce, no throw)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.taskById(1), {
      status: 200,
      body: makeEnvelope("task", makeTaskDetailPayload({ userId: 42 })),
    });
    const out = await getTask(m.client, 1);
    expect(out.userId).toBeNull();
  });

  it("assignees: single-element UUID array is preserved", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.taskById(1), {
      status: 200,
      body: makeEnvelope(
        "task",
        makeTaskDetailPayload({
          assignees: ["f47ac10b-58cc-4372-a567-deadbeef0001"],
        }),
      ),
    });
    const out = await getTask(m.client, 1);
    expect(out.assignees).toEqual(["f47ac10b-58cc-4372-a567-deadbeef0001"]);
  });

  it("assignees: multi-element UUID array is preserved verbatim (order intact)", async () => {
    // Multi-element fixture is unit-test only — sandbox workspace has a
    // single team member (probe 2026-05-13 / session B). Element-type
    // consistency is asserted from the live single-element samples; this
    // freezes the multi-element shape contract independently.
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.taskById(1), {
      status: 200,
      body: makeEnvelope(
        "task",
        makeTaskDetailPayload({
          assignees: [
            "f47ac10b-58cc-4372-a567-deadbeef0001",
            "b2c9f357-c0e6-5e54-ba37-cafebabe0002",
          ],
        }),
      ),
    });
    const out = await getTask(m.client, 1);
    expect(out.assignees).toEqual([
      "f47ac10b-58cc-4372-a567-deadbeef0001",
      "b2c9f357-c0e6-5e54-ba37-cafebabe0002",
    ]);
  });

  it("assignees: empty array is preserved", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.taskById(1), {
      status: 200,
      body: makeEnvelope("task", makeTaskDetailPayload({ assignees: [] })),
    });
    const out = await getTask(m.client, 1);
    expect(out.assignees).toEqual([]);
  });

  it("assignees missing → [] (absence is not drift)", async () => {
    const broken = makeTaskDetailPayload();
    delete broken["assignees"];
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.taskById(1), {
      status: 200,
      body: makeEnvelope("task", broken),
    });
    const out = await getTask(m.client, 1);
    expect(out.assignees).toEqual([]);
  });

  it("assignees: a non-array collection degrades to [] (no throw)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.taskById(1), {
      status: 200,
      body: makeEnvelope(
        "task",
        makeTaskDetailPayload({ assignees: "not array" }),
      ),
    });
    const out = await getTask(m.client, 1);
    expect(out.assignees).toEqual([]);
  });

  it("assignees: a bad (non-string) element degrades the WHOLE field to [] — no placeholder \"\" id", async () => {
    // A mixed/garbled assignee array is untrustworthy as a whole: rather than
    // inject a placeholder "" member id (ADR 0003: no synthetic garbage), the
    // field degrades to []. Sibling *rows* still survive (proven above); this
    // is the element-level policy for one field.
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.taskById(1), {
      status: 200,
      body: makeEnvelope(
        "task",
        makeTaskDetailPayload({
          assignees: ["f47ac10b-58cc-4372-a567-deadbeef0001", 42],
        }),
      ),
    });
    const out = await getTask(m.client, 1);
    expect(out.assignees).toEqual([]);
  });

  it("listTasks: same tolerant multi-assignee discipline applies to TaskSummary", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.tasksList, {
      status: 200,
      body: {
        ...makeEnvelope("tasks", [
          makeTaskSummaryPayload({
            id: 1,
            userId: null,
            assignees: [],
          }),
          makeTaskSummaryPayload({
            id: 2,
            userId: "f47ac10b-58cc-4372-a567-deadbeef0001",
            assignees: [
              "f47ac10b-58cc-4372-a567-deadbeef0001",
              "b2c9f357-c0e6-5e54-ba37-cafebabe0002",
            ],
          }),
        ]),
        hasMore: false,
      },
    });
    const out = await listTasks(m.client, {});
    expect(out.tasks[0]?.userId).toBeNull();
    expect(out.tasks[0]?.assignees).toEqual([]);
    expect(out.tasks[1]?.userId).toBe("f47ac10b-58cc-4372-a567-deadbeef0001");
    expect(out.tasks[1]?.assignees).toHaveLength(2);
  });
});
