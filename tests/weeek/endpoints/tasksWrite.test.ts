import { describe, it, expect } from "vitest";
import {
  completeTask,
  createTask,
  moveTask,
  setTaskMrLink,
  updateTask,
  MR_LINK_FIELD_NAMES,
  WeeekEmptyUpdateError,
  WeeekMrFieldAmbiguousError,
  WeeekMrFieldNotFoundError,
  WeeekWriteLandedError,
} from "../../../src/weeek/endpoints/tasksWrite.js";
import {
  WeeekError,
  WeeekRequestNotSentError,
} from "../../../src/weeek/types.js";
import { humanMessage } from "../../../src/weeek/humanMessage.js";
import { makeMockWeeekClient } from "../../helpers/mockWeeekClient.js";
import {
  makeCustomFieldPayload,
  makeEnvelope,
  makeTaskDetailPayload,
  FIXTURE_MR_FIELD_UUID,
} from "../../helpers/factories.js";
import { silenceShapeWarn } from "../../helpers/shapeWarn.js";
import { logger } from "../../../src/logging/logger.js";
import type { LoggerMethodSpy } from "../../helpers/spies.js";
import { WEEEK_PATH } from "../../helpers/paths.js";

// The read-back leg reuses `getTask`, whose parser is tolerant (I7.5) — keep
// its warn quiet and its dedup reset per case, as in `tasks.test.ts`.
silenceShapeWarn();

// Seeds the two-leg happy path: the completion POST answers with the bare
// `{success:true}` ack Weeek returns for these routes (no task echo), and the
// read-back GET answers with the resulting task.
function seedTwoLegs(
  id: number,
  opts: { completed: boolean; isCompleted?: boolean },
): ReturnType<typeof makeMockWeeekClient> {
  const m = makeMockWeeekClient();
  const path = opts.completed
    ? WEEEK_PATH.taskComplete(id)
    : WEEEK_PATH.taskUnComplete(id);
  m.whenRequest("POST", path, { status: 200, body: { success: true } });
  m.whenRequest("GET", WEEEK_PATH.taskById(id), {
    status: 200,
    body: makeEnvelope(
      "task",
      makeTaskDetailPayload({
        id,
        isCompleted: opts.isCompleted ?? opts.completed,
      }),
    ),
  });
  return m;
}

describe("completeTask — transport", () => {
  it("completed=true POSTs the dedicated /complete route, then reads the task back", async () => {
    const m = seedTwoLegs(42, { completed: true });
    const task = await completeTask(m.client, 42, true);
    const reqs = m.requests();
    expect(reqs.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST ${WEEEK_PATH.taskComplete(42)}`,
      `GET ${WEEEK_PATH.taskById(42)}`,
    ]);
    expect(task.id).toBe(42);
    expect(task.completed).toBe(true);
  });

  it("completed=false POSTs the hyphenated /un-complete route", async () => {
    const m = seedTwoLegs(42, { completed: false });
    await completeTask(m.client, 42, false);
    expect(m.requests()[0]?.path).toBe(WEEEK_PATH.taskUnComplete(42));
  });

  it("sends no request body — the completion routes take none", async () => {
    const m = seedTwoLegs(7, { completed: true });
    await completeTask(m.client, 7, true);
    const post = m.requests()[0];
    expect(post?.method).toBe("POST");
    // `body` is absent (not `null`, not `{}`): `client.request` only serializes
    // a body when the key is present, so an absent key means no bytes sent.
    expect(post && "body" in post ? post.body : undefined).toBeUndefined();
  });

  it("the returned detail is the READ-BACK, not an echo of the request", async () => {
    // The ack carries no task, so what the agent sees is whatever the API
    // reports after the write. Seeding a read-back that disagrees with the
    // requested flag proves we never synthesize the answer from the input.
    const m = seedTwoLegs(9, { completed: true, isCompleted: false });
    const task = await completeTask(m.client, 9, true);
    expect(task.completed).toBe(false);
  });
});

describe("completeTask — failure mapping", () => {
  it("404 on the write leg surfaces weeek_not_found and skips the read-back", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("POST", WEEEK_PATH.taskComplete(99), {
      status: 404,
      body: { success: false },
    });
    await expect(completeTask(m.client, 99, true)).rejects.toMatchObject({
      code: "weeek_not_found",
      status: 404,
    });
    expect(m.requests()).toHaveLength(1);
  });

  it("422 on the write leg surfaces weeek_validation_error (#42)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("POST", WEEEK_PATH.taskComplete(1), {
      status: 422,
      body: { success: false },
    });
    await expect(completeTask(m.client, 1, true)).rejects.toMatchObject({
      code: "weeek_validation_error",
    });
  });

  it("a 200 without the success envelope is weeek_invalid_response", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("POST", WEEEK_PATH.taskComplete(1), {
      status: 200,
      body: { success: false },
    });
    await expect(completeTask(m.client, 1, true)).rejects.toBeInstanceOf(
      WeeekError,
    );
    await expect(completeTask(m.client, 1, true)).rejects.toMatchObject({
      code: "weeek_invalid_response",
    });
  });

  it("a failing read-back raises WeeekWriteLandedError, keeping the read's own code", async () => {
    // The write landed; only the follow-up read failed. The distinct type is
    // what lets the tool say so instead of reporting a landed write as a
    // plain failure.
    const m = makeMockWeeekClient();
    m.whenRequest("POST", WEEEK_PATH.taskComplete(5), {
      status: 200,
      body: { success: true },
    });
    m.whenRequest("GET", WEEEK_PATH.taskById(5), {
      status: 500,
      body: { success: false },
    });
    const err = await completeTask(m.client, 5, true).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WeeekWriteLandedError);
    // Still a WeeekError, so every existing handler path keeps working.
    expect(err).toBeInstanceOf(WeeekError);
    expect((err as WeeekError).code).toBe("weeek_server_error");
    expect((err as WeeekError).status).toBe(500);
  });

  it("a status-less read-back failure (network / timeout) keeps its missing status", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("POST", WEEEK_PATH.taskComplete(5), {
      status: 200,
      body: { success: true },
    });
    m.whenRequest("GET", WEEEK_PATH.taskById(5), () => {
      throw new WeeekError({ code: "weeek_timeout", message: "synthetic" });
    });
    const err = (await completeTask(m.client, 5, true).catch(
      (e: unknown) => e,
    )) as WeeekError;
    expect(err).toBeInstanceOf(WeeekWriteLandedError);
    expect(err.code).toBe("weeek_timeout");
    expect(err.status).toBeUndefined();
  });

  it("a non-Weeek failure on the read-back propagates unwrapped", async () => {
    // Only `WeeekError`s carry a code worth re-labelling; anything else (a
    // programming error, an SDK fault) must reach the tool boundary as-is so
    // it surfaces as a protocol error rather than a tidy tool error.
    const m = makeMockWeeekClient();
    m.whenRequest("POST", WEEEK_PATH.taskComplete(5), {
      status: 200,
      body: { success: true },
    });
    // No GET seeded → the mock throws a plain Error on the read-back leg.
    const err = await completeTask(m.client, 5, true).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(WeeekError);
  });

  it("a failure on the WRITE leg is NOT a read-back error", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("POST", WEEEK_PATH.taskComplete(5), {
      status: 403,
      body: { success: false },
    });
    const err = await completeTask(m.client, 5, true).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WeeekError);
    expect(err).not.toBeInstanceOf(WeeekWriteLandedError);
  });
});

// Seeds the single-leg write: `PUT /tm/tasks/{id}` answers with the full
// updated task, so there is no read-back to mock.
function seedPutEcho(
  id: number,
  overrides: Record<string, unknown> = {},
): ReturnType<typeof makeMockWeeekClient> {
  const m = makeMockWeeekClient();
  m.whenRequest("PUT", WEEEK_PATH.taskById(id), {
    status: 200,
    body: makeEnvelope("task", makeTaskDetailPayload({ id, ...overrides })),
  });
  return m;
}

describe("moveTask — transport", () => {
  it("a column-only move PUTs exactly {boardColumnId} and nothing else", async () => {
    const m = seedPutEcho(42);
    await moveTask(m.client, 42, { boardColumnId: 7 });
    const req = m.requests()[0];
    expect(req?.method).toBe("PUT");
    expect(req?.path).toBe(WEEEK_PATH.taskById(42));
    // `toStrictEqual`, not `toEqual`: the latter ignores keys whose value is
    // `undefined`, so a regression to `{...args}` would slip past it — and a
    // literal `{"boardId": null}` on the wire is not a same-board move.
    expect(req && "body" in req ? req.body : undefined).toStrictEqual({
      boardColumnId: 7,
    });
  });

  it("a board + column move PUTs both — the cross-board re-parent (probe #12)", async () => {
    const m = seedPutEcho(42);
    await moveTask(m.client, 42, { boardColumnId: 9, boardId: 3 });
    const req = m.requests()[0];
    expect(req && "body" in req ? req.body : undefined).toStrictEqual({
      boardId: 3,
      boardColumnId: 9,
    });
  });

  it("never touches the deprecated dedicated change-board endpoints", async () => {
    const m = seedPutEcho(42);
    await moveTask(m.client, 42, { boardColumnId: 9, boardId: 3 });
    for (const req of m.requests()) {
      expect(req.path).not.toContain("/board");
    }
  });

  it("returns the PUT echo parsed as a task detail — no read-back call", async () => {
    const m = seedPutEcho(42, { title: "moved", isCompleted: true });
    const task = await moveTask(m.client, 42, { boardColumnId: 7 });
    expect(task).toMatchObject({ id: 42, title: "moved", completed: true });
    expect(m.requests()).toHaveLength(1);
  });
});

describe("moveTask — failure mapping", () => {
  it.each([
    [404, "weeek_not_found"],
    [422, "weeek_validation_error"],
    [403, "weeek_forbidden"],
  ])("HTTP %i maps to %s", async (status, code) => {
    const m = makeMockWeeekClient();
    m.whenRequest("PUT", WEEEK_PATH.taskById(1), {
      status,
      body: { success: false },
    });
    await expect(
      moveTask(m.client, 1, { boardColumnId: 7 }),
    ).rejects.toMatchObject({ code });
  });

  it("a 200 echo without the task key is weeek_invalid_response — AND the move landed", async () => {
    // Envelope strict, fields tolerant (ADR 0003): a write that cannot show
    // what it wrote is a contract break, not a degraded field. But the write
    // itself went through, so this is a `WeeekWriteLandedError` — a plain
    // `weeek_invalid_response` would have the agent retry a landed move.
    const m = makeMockWeeekClient();
    m.whenRequest("PUT", WEEEK_PATH.taskById(1), {
      status: 200,
      body: { success: true },
    });
    const err = (await moveTask(m.client, 1, { boardColumnId: 7 }).catch(
      (e: unknown) => e,
    )) as WeeekError;
    expect(err).toBeInstanceOf(WeeekWriteLandedError);
    expect(err.code).toBe("weeek_invalid_response");
  });

  it("a NON-2xx is not a landed write — the move never happened", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("PUT", WEEEK_PATH.taskById(1), {
      status: 422,
      body: { success: false },
    });
    const err = await moveTask(m.client, 1, { boardColumnId: 7 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WeeekError);
    expect(err).not.toBeInstanceOf(WeeekWriteLandedError);
  });

  it("the echo is shaped tolerantly, and its drift warn names move_task", async () => {
    // The write echo shares the read's parser (ADR 0003), so a drifted inner
    // field degrades instead of throwing — and the warn tag names the call
    // that produced it, which is the whole reason the parser takes an
    // endpoint argument. `silenceShapeWarn` above spies `logger.warn`.
    const warnSpy = logger.warn as unknown as LoggerMethodSpy;
    const m = seedPutEcho(42, { priority: "not-a-number" });
    const task = await moveTask(m.client, 42, { boardColumnId: 7 });
    expect(task.priority).toBeNull();
    const tags = warnSpy.mock.calls.map((c) => JSON.stringify(c[1] ?? {}));
    expect(tags.join(" ")).toContain("move_task");
    expect(tags.join(" ")).not.toContain("get_task");
  });
});

describe("updateTask — transport", () => {
  it("a single-field update PUTs exactly that field", async () => {
    const m = seedPutEcho(42);
    await updateTask(m.client, 42, { title: "corrected" });
    const req = m.requests()[0];
    expect(req?.method).toBe("PUT");
    expect(req?.path).toBe(WEEEK_PATH.taskById(42));
    // `toStrictEqual`: an un-named field must be ABSENT from the body, not
    // present-and-undefined. The probe (#46) showed `PUT` leaving unnamed
    // fields alone, so absence is what makes "an edit never clobbers a field
    // the agent did not mention" true on the wire.
    expect(req && "body" in req ? req.body : undefined).toStrictEqual({
      title: "corrected",
    });
  });

  it("every supplied field rides along in one body", async () => {
    const m = seedPutEcho(42);
    await updateTask(m.client, 42, {
      title: "corrected",
      priority: 2,
      type: "meet",
      dueDate: "2026-12-31",
    });
    const req = m.requests()[0];
    expect(req && "body" in req ? req.body : undefined).toStrictEqual({
      title: "corrected",
      priority: 2,
      type: "meet",
      dueDate: "2026-12-31",
    });
  });

  it.each([
    ["title", { title: "t" }],
    ["priority", { priority: 3 }],
    ["type", { type: "call" as const }],
    ["dueDate", { dueDate: "2026-01-01" }],
  ])("%s alone is the ONLY key on the wire", async (key, args) => {
    const m = seedPutEcho(14);
    await updateTask(m.client, 14, args);
    const req = m.requests()[0];
    const body = (req && "body" in req ? req.body : {}) as Record<
      string,
      unknown
    >;
    expect(Object.keys(body)).toEqual([key]);
  });

  it.each([
    ["priority", { priority: null }],
    ["dueDate", { dueDate: null }],
  ])("%s: null is sent as null — the API's own way to CLEAR it", async (key, args) => {
    // Probe #46f: `PUT {dueDate: null}` really does drop the due date, and
    // `{priority: null}` really does unset the priority. So `null` here is a
    // supplied value with a meaning, not a synonym for "omitted" — the same
    // distinction `priority: 0` needs, one level up.
    const m = seedPutEcho(20);
    await updateTask(m.client, 20, args);
    const req = m.requests()[0];
    expect(req && "body" in req ? req.body : undefined).toStrictEqual({
      [key]: null,
    });
  });

  it("a null-only update is a real update, not an empty one", async () => {
    // "Clear the due date" names a field to change. If the emptiness guard
    // tested truthiness instead of key count, this would be refused as a
    // no-op and clearing would be unreachable.
    const m = seedPutEcho(21);
    await expect(
      updateTask(m.client, 21, { dueDate: null }),
    ).resolves.toBeDefined();
    expect(m.requests()).toHaveLength(1);
  });

  it("priority 0 is a supplied value, not an absent one", async () => {
    const m = seedPutEcho(15);
    await updateTask(m.client, 15, { priority: 0 });
    const req = m.requests()[0];
    const body = (req && "body" in req ? req.body : {}) as Record<
      string,
      unknown
    >;
    expect(body).toStrictEqual({ priority: 0 });
  });

  it("an empty update issues NO request at all", async () => {
    // The load-bearing assertion of #46, and deliberately stronger than
    // «it rejected the call»: the mock records the request list, so this
    // fails if the guard ever moves downstream of `client.request`. The probe
    // showed `PUT` with `{}` answering 200 and changing nothing — a wasted
    // round-trip against a live workspace that we refuse locally instead.
    const m = seedPutEcho(1);
    await expect(updateTask(m.client, 1, {})).rejects.toBeInstanceOf(
      WeeekEmptyUpdateError,
    );
    expect(m.requests()).toEqual([]);
  });

  it("the empty-update refusal is a WeeekError with the validation code", async () => {
    // Still a `WeeekError`, so the tool's one error leg handles it and
    // INVARIANT-6/7 hold without a second catch block. `weeek_validation_error`
    // is the taxonomy's "you sent something wrong" (docs/errors.md), which is
    // exactly what this is — the fact that no HTTP call was made is carried by
    // the subclass, not by a tenth error code.
    const m = seedPutEcho(1);
    const err = (await updateTask(m.client, 1, {}).catch(
      (e: unknown) => e,
    )) as WeeekError;
    expect(err).toBeInstanceOf(WeeekError);
    expect(err.code).toBe("weeek_validation_error");
    // No HTTP happened, so there is no status to report.
    expect(err.status).toBeUndefined();
  });

  it("the refusal renders as 'not sent', never as 'Weeek rejected it'", async () => {
    // It is a `WeeekRequestNotSentError`, which is what makes `humanMessage`
    // drop the code's default "Weeek rejected the request (HTTP 400/422)"
    // sentence — a claim about an exchange that never took place.
    const m = seedPutEcho(1);
    const err = (await updateTask(m.client, 1, {}).catch(
      (e: unknown) => e,
    )) as WeeekError;
    expect(err).toBeInstanceOf(WeeekRequestNotSentError);
    expect(humanMessage(err)).toContain("The request was not sent");
    expect(humanMessage(err)).not.toContain("HTTP 400/422");
  });

  it("an empty update is not a landed write — nothing was mutated", async () => {
    const m = seedPutEcho(1);
    const err = await updateTask(m.client, 1, {}).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(WeeekWriteLandedError);
  });

  it("returns the PUT echo parsed as a task detail — no read-back call", async () => {
    const m = seedPutEcho(42, { title: "corrected", priority: 3 });
    const task = await updateTask(m.client, 42, { title: "corrected" });
    expect(task).toMatchObject({ id: 42, title: "corrected", priority: 3 });
    expect(m.requests()).toHaveLength(1);
  });
});

describe("updateTask — failure mapping", () => {
  it.each([
    [404, "weeek_not_found"],
    [422, "weeek_validation_error"],
    [403, "weeek_forbidden"],
  ])("HTTP %i maps to %s", async (status, code) => {
    const m = makeMockWeeekClient();
    m.whenRequest("PUT", WEEEK_PATH.taskById(1), {
      status,
      body: { success: false },
    });
    await expect(
      updateTask(m.client, 1, { title: "t" }),
    ).rejects.toMatchObject({ code });
  });

  it("a 200 echo without the task key is weeek_invalid_response — AND the edit landed", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("PUT", WEEEK_PATH.taskById(1), {
      status: 200,
      body: { success: true },
    });
    const err = (await updateTask(m.client, 1, { title: "t" }).catch(
      (e: unknown) => e,
    )) as WeeekError;
    expect(err).toBeInstanceOf(WeeekWriteLandedError);
    expect(err.code).toBe("weeek_invalid_response");
  });

  it("a NON-2xx is not a landed write — the edit never happened", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("PUT", WEEEK_PATH.taskById(1), {
      status: 422,
      body: { success: false },
    });
    const err = await updateTask(m.client, 1, { title: "t" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WeeekError);
    expect(err).not.toBeInstanceOf(WeeekWriteLandedError);
  });

  it("the echo is shaped tolerantly, and its drift warn names update_task", async () => {
    // Same parser as the read and the move (ADR 0003) — the endpoint tag is
    // what keeps a drift warn attributable to the call that produced it.
    const warnSpy = logger.warn as unknown as LoggerMethodSpy;
    const m = seedPutEcho(42, { priority: "not-a-number" });
    const task = await updateTask(m.client, 42, { title: "t" });
    expect(task.priority).toBeNull();
    const tags = warnSpy.mock.calls.map((c) => JSON.stringify(c[1] ?? {}));
    expect(tags.join(" ")).toContain("update_task");
    expect(tags.join(" ")).not.toContain("move_task");
  });
});

// Seeds the create write: `POST /tm/tasks` answers with the full new task
// (probe #45, 2026-07-22), so there is no read-back leg here either.
function seedCreateEcho(
  id: number,
  overrides: Record<string, unknown> = {},
): ReturnType<typeof makeMockWeeekClient> {
  const m = makeMockWeeekClient();
  m.whenRequest("POST", WEEEK_PATH.tasksList, {
    status: 200,
    body: makeEnvelope("task", makeTaskDetailPayload({ id, ...overrides })),
  });
  return m;
}

describe("createTask — transport", () => {
  it("a minimal create POSTs exactly the title and the project — nothing else", async () => {
    const m = seedCreateEcho(12);
    await createTask(m.client, { title: "file this", projectId: 1 });
    const req = m.requests()[0];
    expect(req?.method).toBe("POST");
    expect(req?.path).toBe(WEEEK_PATH.tasksList);
    // `toStrictEqual`, not `toEqual`: the latter ignores keys whose value is
    // `undefined`, so a regression to `{...args}` would slip past it. An
    // absent optional must be absent from the wire, never `null` — Weeek
    // applies its own default only for a key it does not receive.
    expect(req && "body" in req ? req.body : undefined).toStrictEqual({
      title: "file this",
      projectId: 1,
    });
  });

  it("every supplied optional rides along in one body", async () => {
    const m = seedCreateEcho(13);
    await createTask(m.client, {
      title: "with optionals",
      projectId: 1,
      description: "why this matters",
      type: "call",
      priority: 2,
      boardId: 1,
      boardColumnId: 2,
      assignees: ["f47ac10b-58cc-4372-a567-deadbeef0003"],
      dueDate: "2026-12-31",
    });
    const req = m.requests()[0];
    expect(req && "body" in req ? req.body : undefined).toStrictEqual({
      title: "with optionals",
      projectId: 1,
      description: "why this matters",
      type: "call",
      priority: 2,
      boardId: 1,
      boardColumnId: 2,
      assignees: ["f47ac10b-58cc-4372-a567-deadbeef0003"],
      dueDate: "2026-12-31",
    });
  });

  it.each([
    ["description", { description: "d" }],
    ["type", { type: "meet" as const }],
    ["priority", { priority: 0 }],
    ["boardId", { boardId: 4 }],
    ["boardColumnId", { boardColumnId: 5 }],
    ["assignees", { assignees: ["uuid-1"] }],
    ["dueDate", { dueDate: "2026-01-01" }],
  ])(
    "%s alone is the ONLY key added to the minimal body",
    async (key, extra) => {
      // Each optional is independently omissible: the failure this guards is a
      // body built by spreading, where every un-supplied sibling arrives as an
      // explicit `undefined`/`null` and overrides a Weeek default.
      const m = seedCreateEcho(14);
      await createTask(m.client, { title: "t", projectId: 1, ...extra });
      const req = m.requests()[0];
      const body = (req && "body" in req ? req.body : {}) as Record<
        string,
        unknown
      >;
      expect(Object.keys(body).sort()).toEqual(
        ["title", "projectId", key].sort(),
      );
    },
  );

  it("priority 0 survives — a falsy value is supplied, not absent", async () => {
    // The classic `if (args.priority)` bug: 0 is "Low", not "unset".
    const m = seedCreateEcho(15);
    await createTask(m.client, { title: "t", projectId: 1, priority: 0 });
    const req = m.requests()[0];
    const body = (req && "body" in req ? req.body : {}) as Record<
      string,
      unknown
    >;
    expect(body["priority"]).toBe(0);
  });

  it("an empty assignee list is sent as given, not dropped", async () => {
    const m = seedCreateEcho(16);
    await createTask(m.client, { title: "t", projectId: 1, assignees: [] });
    const req = m.requests()[0];
    const body = (req && "body" in req ? req.body : {}) as Record<
      string,
      unknown
    >;
    expect(body["assignees"]).toStrictEqual([]);
  });

  it("returns the POST echo parsed as a task detail — no read-back call", async () => {
    const m = seedCreateEcho(12, { title: "file this", isCompleted: false });
    const task = await createTask(m.client, { title: "file this", projectId: 1 });
    expect(task).toMatchObject({ id: 12, title: "file this", completed: false });
    expect(m.requests()).toHaveLength(1);
  });
});

describe("createTask — failure mapping", () => {
  it.each([
    [404, "weeek_not_found"],
    [422, "weeek_validation_error"],
    [403, "weeek_forbidden"],
  ])("HTTP %i maps to %s", async (status, code) => {
    const m = makeMockWeeekClient();
    m.whenRequest("POST", WEEEK_PATH.tasksList, {
      status,
      body: { success: false },
    });
    await expect(
      createTask(m.client, { title: "t", projectId: 1 }),
    ).rejects.toMatchObject({ code });
  });

  it("a 200 echo without the task key is weeek_invalid_response — AND the task exists", async () => {
    // The costliest landed write in the set: the task is in the workspace and
    // its id is the one thing the caller cannot recover by retrying, because a
    // retry files a SECOND task.
    const m = makeMockWeeekClient();
    m.whenRequest("POST", WEEEK_PATH.tasksList, {
      status: 200,
      body: { success: true },
    });
    const err = (await createTask(m.client, { title: "t", projectId: 1 }).catch(
      (e: unknown) => e,
    )) as WeeekError;
    expect(err).toBeInstanceOf(WeeekWriteLandedError);
    expect(err.code).toBe("weeek_invalid_response");
  });

  it("a NON-2xx is not a landed write — nothing was created", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("POST", WEEEK_PATH.tasksList, {
      status: 422,
      body: { success: false },
    });
    const err = await createTask(m.client, { title: "t", projectId: 1 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WeeekError);
    expect(err).not.toBeInstanceOf(WeeekWriteLandedError);
  });

  it("the echo is shaped tolerantly, and its drift warn names create_task", async () => {
    const warnSpy = logger.warn as unknown as LoggerMethodSpy;
    const m = seedCreateEcho(12, { priority: "not-a-number" });
    const task = await createTask(m.client, { title: "t", projectId: 1 });
    expect(task.priority).toBeNull();
    const tags = warnSpy.mock.calls.map((c) => JSON.stringify(c[1] ?? {}));
    expect(tags.join(" ")).toContain("create_task");
    expect(tags.join(" ")).not.toContain("get_task");
  });
});

// --- I8 (#47) `setTaskMrLink` — the map-not-array write + the field ladder.

const MR_URL = "https://gitlab.example.com/acme/api/-/merge_requests/17";
const OTHER_FIELD_UUID = "7e2a55f0-1111-4222-8333-000000000009";

// Seeds the by-name path: the custom-fields listing the resolver reads, then
// the task `PUT` that carries the map body.
function seedMrLink(
  id: number,
  fields: Array<Record<string, unknown>>,
): ReturnType<typeof makeMockWeeekClient> {
  const m = makeMockWeeekClient();
  m.whenRequest("GET", WEEEK_PATH.customFieldsList, {
    status: 200,
    body: makeEnvelope("data", fields),
  });
  m.whenRequest("PUT", WEEEK_PATH.taskById(id), {
    status: 200,
    body: makeEnvelope("task", makeTaskDetailPayload({ id })),
  });
  return m;
}

function bodyOfPut(
  m: ReturnType<typeof makeMockWeeekClient>,
): Record<string, unknown> {
  const put = m.requests().find((r) => r.method === "PUT");
  return (put && "body" in put ? put.body : {}) as Record<string, unknown>;
}

describe("setTaskMrLink — the write body is a MAP, never an array", () => {
  it("writes {customFields: {<uuid>: <url>}} — asserted on the recorded body", async () => {
    // THE test of #47. The array form — `customFields: [{id, value}]` — is
    // accepted with a **200 and silently discarded** (probe #12), so a status
    // assertion would pass for a write that never happened. Only the recorded
    // body distinguishes the two, which is why it is asserted here rather than
    // inferred from a green response.
    const m = seedMrLink(5, [makeCustomFieldPayload()]);
    await setTaskMrLink(m.client, 5, { url: MR_URL });
    expect(bodyOfPut(m)).toStrictEqual({
      customFields: { [FIXTURE_MR_FIELD_UUID]: MR_URL },
    });
  });

  it("the customFields value is a plain object — an array would be the silent no-op", async () => {
    const m = seedMrLink(5, [makeCustomFieldPayload()]);
    await setTaskMrLink(m.client, 5, { url: MR_URL });
    const cf = bodyOfPut(m)["customFields"];
    expect(Array.isArray(cf)).toBe(false);
    expect(cf).toBeInstanceOf(Object);
    // The id is the KEY. In the array form it would be a `id` property on an
    // element instead, which is exactly the shape that gets dropped.
    expect(Object.keys(cf as object)).toEqual([FIXTURE_MR_FIELD_UUID]);
  });

  it("the value is the URL string itself (a `link` field takes a plain string)", async () => {
    const m = seedMrLink(5, [makeCustomFieldPayload()]);
    await setTaskMrLink(m.client, 5, { url: MR_URL });
    const cf = bodyOfPut(m)["customFields"] as Record<string, unknown>;
    expect(cf[FIXTURE_MR_FIELD_UUID]).toBe(MR_URL);
  });

  it("nothing else rides along — no title, no board, no completion flag", async () => {
    const m = seedMrLink(5, [makeCustomFieldPayload()]);
    await setTaskMrLink(m.client, 5, { url: MR_URL });
    expect(Object.keys(bodyOfPut(m))).toEqual(["customFields"]);
  });

  it("PUTs the task path and returns the echoed task", async () => {
    const m = seedMrLink(5, [makeCustomFieldPayload()]);
    const task = await setTaskMrLink(m.client, 5, { url: MR_URL });
    expect(m.requests().map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET ${WEEEK_PATH.customFieldsList}`,
      `PUT ${WEEEK_PATH.taskById(5)}`,
    ]);
    expect(task.id).toBe(5);
  });
});

describe("setTaskMrLink — the field-resolution ladder (ADR 0005 §3)", () => {
  it("rung 2: an explicit field id skips the listing request entirely", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("PUT", WEEEK_PATH.taskById(5), {
      status: 200,
      body: makeEnvelope("task", makeTaskDetailPayload({ id: 5 })),
    });
    // No listing response is registered at all: the mock throws on an
    // unregistered path, so a resolver that listed anyway fails loudly here
    // rather than passing on a fixture that quietly permitted it.
    await setTaskMrLink(m.client, 5, {
      url: MR_URL,
      customFieldId: OTHER_FIELD_UUID,
    });
    expect(m.requests().map((r) => r.method)).toEqual(["PUT"]);
    expect(bodyOfPut(m)).toStrictEqual({
      customFields: { [OTHER_FIELD_UUID]: MR_URL },
    });
  });

  it("rung 1: a candidate name resolves to its id, case-insensitively", async () => {
    const m = seedMrLink(5, [
      makeCustomFieldPayload({ name: "  mR LiNk  " }),
    ]);
    await setTaskMrLink(m.client, 5, { url: MR_URL });
    expect(bodyOfPut(m)).toStrictEqual({
      customFields: { [FIXTURE_MR_FIELD_UUID]: MR_URL },
    });
  });

  it("every published candidate name resolves", async () => {
    // The list is exported so the tool description and the API notes cannot
    // drift from what the resolver actually matches — this drives it from the
    // same constant rather than a second copy.
    for (const name of MR_LINK_FIELD_NAMES) {
      const m = seedMrLink(5, [makeCustomFieldPayload({ name })]);
      await setTaskMrLink(m.client, 5, { url: MR_URL });
      expect(Object.keys(bodyOfPut(m)["customFields"] as object)).toEqual([
        FIXTURE_MR_FIELD_UUID,
      ]);
    }
  });

  it("an explicitly supplied name takes precedence over the candidate list", async () => {
    const m = seedMrLink(5, [
      makeCustomFieldPayload({ name: "MR link" }),
      makeCustomFieldPayload({ id: OTHER_FIELD_UUID, name: "Ревью" }),
    ]);
    await setTaskMrLink(m.client, 5, { url: MR_URL, customFieldName: "ревью" });
    expect(bodyOfPut(m)).toStrictEqual({
      customFields: { [OTHER_FIELD_UUID]: MR_URL },
    });
  });

  it("a field id and a name together: the id wins, and no listing is issued", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("PUT", WEEEK_PATH.taskById(5), {
      status: 200,
      body: makeEnvelope("task", makeTaskDetailPayload({ id: 5 })),
    });
    await setTaskMrLink(m.client, 5, {
      url: MR_URL,
      customFieldId: OTHER_FIELD_UUID,
      customFieldName: "MR link",
    });
    expect(m.requests().map((r) => r.method)).toEqual(["PUT"]);
  });

  it("two matching fields are an ERROR, not a coin flip — and no write is issued", async () => {
    const m = seedMrLink(5, [
      makeCustomFieldPayload({ name: "MR link" }),
      makeCustomFieldPayload({ id: OTHER_FIELD_UUID, name: "Merge request" }),
    ]);
    const err = (await setTaskMrLink(m.client, 5, { url: MR_URL }).catch(
      (e: unknown) => e,
    )) as WeeekError;
    expect(err).toBeInstanceOf(WeeekMrFieldAmbiguousError);
    expect(m.requests().map((r) => r.method)).toEqual(["GET"]);
  });

  it("rung 3: nothing matches → a clean error, and NOT ONE write request", async () => {
    // The acceptance criterion, asserted on the recorded requests rather than
    // on the error alone: a resolver that fell through to writing with an
    // empty or guessed id would still reject afterwards and look identical
    // from the error's side.
    const m = seedMrLink(5, [
      makeCustomFieldPayload({ name: "Estimate", type: "number" }),
    ]);
    const err = (await setTaskMrLink(m.client, 5, { url: MR_URL }).catch(
      (e: unknown) => e,
    )) as WeeekError;
    expect(err).toBeInstanceOf(WeeekMrFieldNotFoundError);
    expect(m.requests().map((r) => r.method)).toEqual(["GET"]);
  });

  it("a tenant with no custom fields at all lands on rung 3", async () => {
    const m = seedMrLink(5, []);
    await expect(
      setTaskMrLink(m.client, 5, { url: MR_URL }),
    ).rejects.toBeInstanceOf(WeeekMrFieldNotFoundError);
  });

  it.each([["number"], ["date"], ["select"], [""]])(
    "a '%s'-typed field is not selectable, however it is named",
    async (type) => {
      // A name match alone is not enough. A field that cannot hold a string
      // takes the URL and — at best — 422s; at worst it answers 200 and drops
      // it, which is the trap this whole tool is shaped around. Only `link`
      // and `text` take a plain string (ADR 0005 §2).
      const m = seedMrLink(5, [makeCustomFieldPayload({ type })]);
      await expect(
        setTaskMrLink(m.client, 5, { url: MR_URL }),
      ).rejects.toBeInstanceOf(WeeekMrFieldNotFoundError);
      expect(m.requests().map((r) => r.method)).toEqual(["GET"]);
    },
  );

  it.each([["link"], ["text"], ["  LINK  "]])(
    "a '%s'-typed field IS selectable",
    async (type) => {
      const m = seedMrLink(5, [makeCustomFieldPayload({ type })]);
      await setTaskMrLink(m.client, 5, { url: MR_URL });
      expect(bodyOfPut(m)).toStrictEqual({
        customFields: { [FIXTURE_MR_FIELD_UUID]: MR_URL },
      });
    },
  );

  it("the type filter does not apply to an explicit id — that path never lists", async () => {
    // Rung 2 is the documented escape hatch from every rung-1 judgement,
    // including this one: the caller who names a UUID has already decided.
    const m = makeMockWeeekClient();
    m.whenRequest("PUT", WEEEK_PATH.taskById(5), {
      status: 200,
      body: makeEnvelope("task", makeTaskDetailPayload({ id: 5 })),
    });
    await setTaskMrLink(m.client, 5, {
      url: MR_URL,
      customFieldId: FIXTURE_MR_FIELD_UUID,
    });
    expect(bodyOfPut(m)).toStrictEqual({
      customFields: { [FIXTURE_MR_FIELD_UUID]: MR_URL },
    });
  });

  it("a name match of the wrong type does not make an otherwise-clean match ambiguous", async () => {
    // The filter runs BEFORE the count, so a stray number-typed "MR link"
    // cannot block a workspace that also holds the real one.
    const m = seedMrLink(5, [
      makeCustomFieldPayload({ name: "MR link", type: "number" }),
      makeCustomFieldPayload({
        id: OTHER_FIELD_UUID,
        name: "MR link",
        type: "link",
      }),
    ]);
    await setTaskMrLink(m.client, 5, { url: MR_URL });
    expect(bodyOfPut(m)).toStrictEqual({
      customFields: { [OTHER_FIELD_UUID]: MR_URL },
    });
  });

  it("a field whose id drifted to '' is not selectable", async () => {
    // Tolerant shaping (ADR 0003) degrades a drifted id to `""`. Writing
    // `{customFields: {"": url}}` would be another 200-that-changes-nothing,
    // so an unusable row must read as "no field defined" instead.
    const m = seedMrLink(5, [makeCustomFieldPayload({ id: 42 })]);
    await expect(
      setTaskMrLink(m.client, 5, { url: MR_URL }),
    ).rejects.toBeInstanceOf(WeeekMrFieldNotFoundError);
    expect(m.requests().map((r) => r.method)).toEqual(["GET"]);
  });

  it("both ladder failures are request-not-sent errors, so nothing was mutated", async () => {
    for (const fields of [
      [makeCustomFieldPayload({ name: "Estimate" })],
      [
        makeCustomFieldPayload({ name: "MR link" }),
        makeCustomFieldPayload({ id: OTHER_FIELD_UUID, name: "PR link" }),
      ],
    ]) {
      const m = seedMrLink(5, fields);
      const err = (await setTaskMrLink(m.client, 5, { url: MR_URL }).catch(
        (e: unknown) => e,
      )) as WeeekError;
      expect(err).toBeInstanceOf(WeeekRequestNotSentError);
      expect(err.code).toBe("weeek_validation_error");
      expect(err.status).toBeUndefined();
      expect(humanMessage(err)).toContain("The request was not sent");
    }
  });

  it("no ladder error carries a workspace field name (INVARIANT-2)", async () => {
    // Field names are tenant data. The error explains what to do about the
    // ambiguity without naming what it saw — the same discipline that keeps
    // task titles out of every other error on this surface.
    const m = seedMrLink(5, [
      makeCustomFieldPayload({ name: "Kingfisher MR" }),
      makeCustomFieldPayload({ id: OTHER_FIELD_UUID, name: "kingfisher mr" }),
    ]);
    const err = (await setTaskMrLink(m.client, 5, {
      url: MR_URL,
      customFieldName: "Kingfisher MR",
    }).catch((e: unknown) => e)) as WeeekError;
    expect(err).toBeInstanceOf(WeeekMrFieldAmbiguousError);
    expect(err.message).not.toContain("Kingfisher");
    expect(err.message).not.toContain("kingfisher");
  });

  it("an explicit name that matches nothing lands on rung 3", async () => {
    const m = seedMrLink(5, [makeCustomFieldPayload({ name: "MR link" })]);
    const err = (await setTaskMrLink(m.client, 5, {
      url: MR_URL,
      customFieldName: "Kingfisher MR",
    }).catch((e: unknown) => e)) as WeeekError;
    // An explicit name REPLACES the candidate list rather than extending it:
    // the workspace's "MR link" field is a candidate match, and it must not be
    // written to when the caller asked for a different field by name.
    expect(err).toBeInstanceOf(WeeekMrFieldNotFoundError);
    expect(err.message).not.toContain("Kingfisher");
    expect(m.requests().map((r) => r.method)).toEqual(["GET"]);
  });

  it("the field-creation endpoint is never called on any ladder path", async () => {
    // ADR 0005 §4: `POST /tm/custom-fields` exists and is deliberately unused —
    // the tool writes INTO an existing field or errors; it never creates one.
    for (const fields of [
      [],
      [makeCustomFieldPayload({ name: "Estimate" })],
      [makeCustomFieldPayload()],
    ]) {
      const m = seedMrLink(5, fields);
      await setTaskMrLink(m.client, 5, { url: MR_URL }).catch(() => undefined);
      expect(
        m.requests().filter((r) => r.path === WEEEK_PATH.customFieldsList),
      ).toEqual([{ method: "GET", path: WEEEK_PATH.customFieldsList }]);
    }
  });
});

describe("setTaskMrLink — failure mapping", () => {
  it("a failing LISTING surfaces its own code and issues no write", async () => {
    // A plan-tier 403 on the listing is the tenant-gated case (ADR 0005 §5).
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.customFieldsList, {
      status: 403,
      body: { success: false },
    });
    await expect(
      setTaskMrLink(m.client, 5, { url: MR_URL }),
    ).rejects.toMatchObject({ code: "weeek_forbidden", status: 403 });
    expect(m.requests().map((r) => r.method)).toEqual(["GET"]);
  });

  it.each([
    [404, "weeek_not_found"],
    [422, "weeek_validation_error"],
  ])("HTTP %i on the write maps to %s", async (status, code) => {
    const m = makeMockWeeekClient();
    m.whenRequest("PUT", WEEEK_PATH.taskById(5), {
      status,
      body: { success: false },
    });
    await expect(
      setTaskMrLink(m.client, 5, {
        url: MR_URL,
        customFieldId: FIXTURE_MR_FIELD_UUID,
      }),
    ).rejects.toMatchObject({ code });
  });

  it("a 200 echo without the task key means the LINK landed but is unreadable", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("PUT", WEEEK_PATH.taskById(5), {
      status: 200,
      body: { success: true },
    });
    const err = (await setTaskMrLink(m.client, 5, {
      url: MR_URL,
      customFieldId: FIXTURE_MR_FIELD_UUID,
    }).catch((e: unknown) => e)) as WeeekError;
    expect(err).toBeInstanceOf(WeeekWriteLandedError);
  });

  it("a NON-2xx is not a landed write", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("PUT", WEEEK_PATH.taskById(5), {
      status: 422,
      body: { success: false },
    });
    const err = await setTaskMrLink(m.client, 5, {
      url: MR_URL,
      customFieldId: FIXTURE_MR_FIELD_UUID,
    }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(WeeekWriteLandedError);
  });

  it("the echo is shaped tolerantly, and its drift warn names set_task_mr_link", async () => {
    const warnSpy = logger.warn as unknown as LoggerMethodSpy;
    const m = makeMockWeeekClient();
    m.whenRequest("PUT", WEEEK_PATH.taskById(5), {
      status: 200,
      body: makeEnvelope(
        "task",
        makeTaskDetailPayload({ id: 5, priority: "not-a-number" }),
      ),
    });
    const task = await setTaskMrLink(m.client, 5, {
      url: MR_URL,
      customFieldId: FIXTURE_MR_FIELD_UUID,
    });
    expect(task.priority).toBeNull();
    const tags = warnSpy.mock.calls.map((c) => JSON.stringify(c[1] ?? {}));
    expect(tags.join(" ")).toContain("set_task_mr_link");
  });
});
