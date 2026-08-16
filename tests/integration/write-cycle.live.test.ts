import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  completeTask,
  createTask,
  getTask,
  listBoardColumns,
  listBoards,
  moveTask,
  setTaskMrLink,
  updateTask,
  MR_LINK_FIELD_NAMES,
  WeeekMrFieldAmbiguousError,
  WeeekMrFieldNotFoundError,
} from "../../src/weeek/endpoints.js";
// Not re-exported from the barrel: the custom-field listing is an internal
// read (`weeek_set_task_mr_link`'s name → id resolution, ADR 0005 §4), not
// part of the tool-facing surface. The harness reaches for the module
// directly rather than widening that barrel for a test.
import { listCustomFields } from "../../src/weeek/endpoints/customFields.js";
import { parseWeeekAck } from "../../src/weeek/unwrap.js";
import type { BoardColumnSummary } from "../../src/weeek/types.js";
import {
  deleteRaw,
  readRawTask,
  tryLiveWriteContext,
  type LiveWriteContext,
} from "./setup.js";

// The live WRITE cycle (#49) — create → update → move → complete against a
// real workspace, then clean up after itself.
//
// Why this exists when every write tool already has a mock suite: a mock can
// prove the bytes we send and structurally CANNOT prove Weeek stored them.
// Weeek accepts an unknown or wrongly-shaped write field with a **200 and
// silently ignores it** (the `customFields`-array trap, probe #12; the
// `description`-on-update no-op, probe #46), so a status-code assertion is
// exactly the assertion that trap defeats. Every leg below therefore ends in
// a **re-read** — and for the fields the tool-facing `TaskDetail` does not
// carry, a raw re-read (`readRawTask`), because a write verified through our
// own narrowing parser is a write verified against ourselves.
//
// Gated on `WEEEK_INTEGRATION_TOKEN` + `WEEEK_INTEGRATION_PROJECT_ID`; with
// either absent the whole file skips and `npm test` (which excludes this
// directory outright) stays green regardless. Runs on the release-tag
// `live-smoke.yml` workflow only — the PR matrix stays mock-only.
//
// **Sandbox prerequisite** (one, documented in the README's live-integration
// section): the nominated project needs a board with at least two columns — a
// move needs somewhere to move *to*, and no API call can conjure a column.
// It FAILS with a sentence naming it rather than skipping the leg: a silently
// skipped assertion is the same as no assertion.
//
// The MR-link field the round-trip needs is **provisioned by the harness**
// when the workspace has none, and deleted again in cleanup, so a bare sandbox
// needs no manual preparation. A field that was already there is used as-is
// and never deleted — it is the operator's, and this suite's clean-up-after-
// yourself rule does not extend to tidying away someone else's workspace
// configuration.

const ctx = tryLiveWriteContext();

// Stamped into every title this suite writes, so an abandoned fixture (a run
// killed between create and cleanup) is greppable in the sandbox and
// attributable to a run rather than to a person.
const RUN_ID = `${Date.now().toString(36)}-${String(process.pid)}`;
const TITLE_CREATED = `[weeek-mcp live #49] write-cycle ${RUN_ID}`;
const TITLE_UPDATED = `${TITLE_CREATED} (edited)`;
const TITLE_LEFTOVER = `[weeek-mcp live #49 LEFTOVER] ${RUN_ID}`;
const MR_URL = `https://example.invalid/mr/${RUN_ID}`;
const DUE_DATE = "2030-01-01";

// The name the harness provisions its own MR-link field under: the first
// candidate the resolver matches, so the round-trip exercises the by-name
// ladder (ADR 0005 §3 rung 1) rather than short-circuiting it with an id.
const MR_FIELD_NAME = MR_LINK_FIELD_NAMES[0];
// `link` and `text` are the two types a plain string may be written into.
const MR_FIELD_TYPE = "link";
const STRING_VALUED_TYPES = new Set(["link", "text"]);

function foldKey(value: string): string {
  return value.trim().toLowerCase();
}

// Which existing fields the resolver would consider. Deliberately a copy of
// `resolveMrLinkFieldId`'s predicate rather than an export of it: the copy is
// used for ONE decision — "must this harness provision a field?" — and if the
// two ever drift, the harness provisions a second matching field and
// `setTaskMrLink` reports the ambiguity out loud. A shared helper would make
// the pre-check agree with the resolver by construction, including when both
// are wrong.
function mrLinkCandidates(
  fields: readonly { id: string; name: string; type: string }[],
): readonly { id: string; name: string }[] {
  const wanted = new Set(MR_LINK_FIELD_NAMES.map(foldKey));
  return fields.filter(
    (f) =>
      f.id !== "" &&
      wanted.has(foldKey(f.name)) &&
      STRING_VALUED_TYPES.has(foldKey(f.type)),
  );
}

// What `ensureMrLinkField` hands back. `ownedIds` — the fields THIS RUN
// created, which cleanup must delete — is reported **separately from** the
// failure, and that separation is the whole point of returning a result
// instead of throwing: a create that lands and then fails its verification is
// exactly the case where a field exists and nobody is left holding its id.
interface MrFieldSetup {
  ownedIds: readonly string[];
  problem?: string;
}

// Make sure the workspace has the MR-link field the round-trip writes into.
//
// A field that is already there is used as-is and reported as owned by
// nobody — it is the operator's, and cleaning up after ourselves does not
// extend to deleting their workspace configuration.
//
// `POST /tm/custom-fields` is a path `src/**` never calls (custom-field CRUD
// was declined in the scope lock #9) — it is called HERE, in test code, for
// the same reason the raw `DELETE` is: the harness needs the capability and
// the server must not have it.
async function ensureMrLinkField(
  live: LiveWriteContext,
): Promise<MrFieldSetup> {
  const before = mrLinkCandidates(await listCustomFields(live.client));
  if (before.length > 1) {
    return {
      ownedIds: [],
      problem:
        "sandbox prerequisite unmet: more than one custom field matches the MR-link names — leave exactly one",
    };
  }
  if (before.length === 1) return { ownedIds: [] };

  const raw = await live.client.request({
    method: "POST",
    path: "/tm/custom-fields",
    body: { name: MR_FIELD_NAME, type: MR_FIELD_TYPE },
  });
  parseWeeekAck(raw.status, raw.body);
  // The id comes from a re-listing rather than from the POST's echo, because
  // the create response shape is undocumented and unprobed, while the listing
  // shape is the one `setTaskMrLink` itself depends on. One extra GET buys
  // independence from a shape we would otherwise be guessing at.
  //
  // Everything the listing now holds and did not hold a moment ago is ours,
  // however many that turns out to be — claimed before any verdict on whether
  // the provisioning went as intended.
  const seen = new Set(before.map((f) => f.id));
  const created = mrLinkCandidates(await listCustomFields(live.client)).filter(
    (f) => !seen.has(f.id),
  );
  const ownedIds = created.map((f) => f.id);
  if (created.length === 0) {
    return {
      ownedIds,
      problem:
        "provisioning an MR-link custom field answered 2xx but the field is not in the listing",
    };
  }
  if (created.length > 1) {
    return {
      ownedIds,
      problem:
        "provisioning an MR-link custom field produced more than one match",
    };
  }
  return { ownedIds };
}

describe.skipIf(!ctx)("live: write cycle (token + sandbox project)", () => {
  if (!ctx) return;
  const live = ctx;

  // The fixture, shared across legs in declaration order (vitest runs
  // it-blocks in a file sequentially). Recorded the instant the create
  // returns — before any assertion — so a failed assertion still leaves
  // cleanup something to delete.
  let taskId: number | undefined;
  let columns: readonly BoardColumnSummary[] = [];
  // The custom fields THIS RUN created, if any. A pre-existing one is the
  // operator's and is left alone at cleanup.
  let ownedFieldIds: readonly string[] = [];

  function requireTaskId(): number {
    if (taskId === undefined) {
      throw new Error(
        "no fixture task: the create leg did not land, so this leg cannot run",
      );
    }
    return taskId;
  }

  beforeAll(async () => {
    // Resolved before the create so the fixture starts in a KNOWN column and
    // the move leg has a distinct target — "it moved" is only assertable
    // against a start state we chose.
    const boards = await listBoards(live.client, live.projectId);
    for (const board of boards) {
      const boardColumns = await listBoardColumns(live.client, board.id);
      if (boardColumns.length >= 2) {
        columns = boardColumns;
        break;
      }
    }
    if (columns.length < 2) {
      throw new Error(
        `sandbox prerequisite unmet: project ${String(live.projectId)} needs a board with at least two columns for the move leg`,
      );
    }

    // The MR-link field: use what is there, provision what is not. Resolved
    // here rather than inside the leg so a workspace problem surfaces before
    // any task is created — and so cleanup knows what this run owns.
    //
    // Ownership is recorded BEFORE the failure is raised: a provisioning that
    // half-worked has still created something, and a `throw` that skipped this
    // assignment would leak precisely the field this run made.
    const field = await ensureMrLinkField(live);
    ownedFieldIds = field.ownedIds;
    if (field.problem !== undefined) throw new Error(field.problem);
  });

  afterAll(async () => {
    // Both fixtures are attempted before anything is reported, so a task that
    // will not delete cannot strand the custom field behind it. Problems are
    // collected and thrown once at the end — a sandbox silently accumulating
    // fixtures is a defect, not a warning.
    const problems: string[] = [];
    if (taskId !== undefined) {
      // `cleanUpTask` reports rather than throws — the `catch` is the belt to
      // that braces, so that even an unforeseen throw cannot cost the field
      // deletion below.
      try {
        problems.push(...(await cleanUpTask(taskId)));
      } catch {
        problems.push(
          `cleanup of task ${String(taskId)} failed unexpectedly — check the sandbox by hand`,
        );
      }
    }
    for (const fieldId of ownedFieldIds) {
      const status = await attemptDelete(`/tm/custom-fields/${fieldId}`);
      if (status < 200 || status >= 300) {
        problems.push(
          `failed to delete the custom field this run created (HTTP ${String(status)}) — remove the "${MR_FIELD_NAME}" field by hand`,
        );
      }
    }
    if (problems.length > 0) throw new Error(problems.join("; "));
  });

  // Try to delete, and answer with the HTTP status — or `0`, the sentinel for
  // "the request never got an answer at all". A transport failure and a
  // refusal are the same thing to cleanup (both mean "still there"), so the
  // one non-status value collapses them into the path that already says what
  // to do about it.
  async function attemptDelete(path: string): Promise<number> {
    try {
      return await deleteRaw(live, path);
    } catch {
      return 0;
    }
  }

  async function cleanUpTask(id: number): Promise<string[]> {
    // Delete for real (`DELETE /tm/tasks/{id}`, probe #45) rather than the
    // "complete it and mark the title" fallback #49 was written against —
    // upstream has the route, so a sandbox does not accumulate fixtures at
    // all. The fallback below survives for the case where it fails.
    const status = await attemptDelete(`/tm/tasks/${String(id)}`);
    if (status >= 200 && status < 300) {
      // Soft delete (probe #51): the task leaves every listing but a direct
      // read still resolves, with `isDeleted: true`. Check the flag rather
      // than expecting a 404, which is what a hard delete would produce.
      //
      // Reported rather than thrown (no `expect` here): this runs inside the
      // cleanup sequence, and a throw would abandon the custom-field deletion
      // that comes after it — trading one leftover for another.
      let removed: Record<string, unknown>;
      try {
        removed = await readRawTask(live, id);
      } catch {
        return [
          `task ${String(id)} answered 2xx to DELETE but the confirming read failed`,
        ];
      }
      return removed["isDeleted"] === true
        ? []
        : [
            `task ${String(id)} answered 2xx to DELETE but does not read back as deleted`,
          ];
    }
    // Mark the survivor identifiably and park it out of the way, so an
    // operator can find and remove it by hand.
    let marked: boolean;
    try {
      await updateTask(live.client, id, { title: TITLE_LEFTOVER });
      await completeTask(live.client, id, true);
      marked = true;
    } catch {
      marked = false;
    }
    return [
      `failed to delete task ${String(id)} (HTTP ${String(status)}); ` +
        (marked
          ? `it is marked "${TITLE_LEFTOVER}" and completed — remove it by hand`
          : "marking it failed too — remove it by hand"),
    ];
  }

  it("POST /tm/tasks files a task into the sandbox project", async () => {
    const startColumn = columns[0]!;
    const created = await createTask(live.client, {
      title: TITLE_CREATED,
      projectId: live.projectId,
      type: "action",
      priority: 3,
      boardColumnId: startColumn.id,
    });
    // Recorded before the assertions — see `afterAll`.
    taskId = created.id;

    expect(created.id).toBeTypeOf("number");
    expect(created.title).toBe(TITLE_CREATED);
    expect(created.projectId).toBe(live.projectId);
    expect(created.type).toBe("action");
    expect(created.priority).toBe(3);
    expect(created.completed).toBe(false);

    // The create echoes the new task, so the assertions above are already a
    // read of upstream state — but not of the fields `TaskDetail` drops, and
    // the starting column is one the move leg depends on.
    const raw = await readRawTask(live, created.id);
    expect(raw["boardColumnId"]).toBe(startColumn.id);
    expect(raw["boardId"]).toBe(startColumn.boardId);
  });

  it("PUT /tm/tasks/{id} edits fields, and the edit survives a re-read", async () => {
    const id = requireTaskId();
    const updated = await updateTask(live.client, id, {
      title: TITLE_UPDATED,
      priority: 1,
      dueDate: DUE_DATE,
    });
    expect(updated.title).toBe(TITLE_UPDATED);
    expect(updated.priority).toBe(1);

    const reread = await getTask(live.client, id);
    expect(reread.title).toBe(TITLE_UPDATED);
    expect(reread.priority).toBe(1);
    // `dueDate` is not a `TaskDetail` field; the raw read is the only place
    // its persistence is visible.
    const raw = await readRawTask(live, id);
    expect(raw["dueDate"]).toBe(DUE_DATE);
    // The fields the edit did not name are untouched — the guarantee the
    // key-by-key body build exists to provide (probe #46).
    expect(raw["type"]).toBe("action");
  });

  it("PUT /tm/tasks/{id} with an explicit null CLEARS priority and due date", async () => {
    const id = requireTaskId();
    const cleared = await updateTask(live.client, id, {
      priority: null,
      dueDate: null,
    });
    // The distinction the whole `number | null` vs `undefined` split in
    // `UpdateTaskArgs` exists for: "clear it" is a different request from
    // "leave it alone", and only a live re-read proves the API honours it.
    expect(cleared.priority).toBeNull();
    const raw = await readRawTask(live, id);
    expect(raw["priority"]).toBeNull();
    expect(raw["dueDate"]).toBeNull();
    // Not a blanket overwrite: the title the previous leg set survives.
    expect(raw["title"]).toBe(TITLE_UPDATED);
  });

  it("PUT /tm/tasks/{id} moves the task to another column", async () => {
    const id = requireTaskId();
    const target = columns[1]!;
    const moved = await moveTask(live.client, id, {
      boardColumnId: target.id,
      boardId: target.boardId,
    });
    expect(moved.id).toBe(id);

    // A column change is invisible in `TaskDetail` — the tool returns the
    // task, and the *status* it just changed is not one of the fields it
    // carries. The raw read is what makes the move assertable at all.
    const raw = await readRawTask(live, id);
    expect(raw["boardColumnId"]).toBe(target.id);
    expect(raw["boardId"]).toBe(target.boardId);
  });

  it("PUT /tm/tasks/{id} round-trips the MR link: written as a map, re-read, present", async () => {
    const id = requireTaskId();
    // THE assertion a mock structurally cannot make (ADR 0005). The array
    // form of this body — the shape a reader naturally reproduces, since a
    // task READS its custom fields back as an array — answers 200 and
    // silently discards the value. Only the re-read below separates the two.
    try {
      await setTaskMrLink(live.client, id, { url: MR_URL });
    } catch (err) {
      // Both rungs of the resolution ladder were settled in `beforeAll` — a
      // field was found or provisioned there — so reaching either of these
      // means the pre-check and the resolver disagree about what counts as an
      // MR-link field, not that the workspace is unprepared. Say so, rather
      // than sending an operator to fix a workspace that is already correct.
      if (
        err instanceof WeeekMrFieldNotFoundError ||
        err instanceof WeeekMrFieldAmbiguousError
      ) {
        throw new Error(
          `the harness resolved an MR-link field in setup but setTaskMrLink did not (${err.name}) — the two predicates have drifted`,
          { cause: err },
        );
      }
      throw err;
    }

    const raw = await readRawTask(live, id);
    const fields: unknown = raw["customFields"];
    expect(Array.isArray(fields)).toBe(true);
    const values = (Array.isArray(fields) ? fields : []).map((entry) =>
      typeof entry === "object" && entry !== null
        ? (entry as Record<string, unknown>)["value"]
        : undefined,
    );
    expect(values).toContain(MR_URL);
  });

  it("POST /tm/tasks/{id}/complete completes the task", async () => {
    const id = requireTaskId();
    // Two legs upstream (POST the route, then GET the task back), so the
    // returned task is already the authoritative read — asserting on it is
    // asserting on stored state, not on the input we sent.
    const completed = await completeTask(live.client, id, true);
    expect(completed.id).toBe(id);
    expect(completed.completed).toBe(true);

    const raw = await readRawTask(live, id);
    expect(raw["isCompleted"]).toBe(true);
  });
});
