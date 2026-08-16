import type { WeeekClient, WeeekRawResponse } from "../client.js";
import { parseWeeekAck } from "../unwrap.js";
import {
  WeeekError,
  WeeekRequestNotSentError,
  type TaskDetail,
} from "../types.js";
import { getTask, parseTaskDetailResponse } from "./tasks.js";
import { listCustomFields } from "./customFields.js";

// The task kinds Weeek accepts on a write. Declared as a value (not just a
// type) because the tool layer turns it into a `z.enum`, and a second
// hand-written copy of the list there is a copy that can drift.
//
// Source: the API spec's `type` enum on the task object, corroborated by probe
// #45 (`type: "call"` round-tripped through a create). The READ side stays a
// tolerant `string` (ADR 0003) — an upstream addition must not break parsing a
// task we did not create.
export const TASK_TYPES = ["action", "meet", "call"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

// Drift-warn tags for the write echoes, so a shape warn names the call that
// produced it rather than the read that shares the parser.
const MOVE_ENDPOINT = "move_task";
const CREATE_ENDPOINT = "create_task";
const UPDATE_ENDPOINT = "update_task";
const SET_MR_LINK_ENDPOINT = "set_task_mr_link";

// Raised when the MUTATION LANDED and only the resulting task could not be
// obtained — either the follow-up read failed (the two-leg writes) or a 2xx
// echo could not be parsed into a task (the single-leg writes). It carries the
// underlying failure's own code and status, because that failure is real; the
// distinct type is what lets a tool say "the write happened" instead of
// reporting a landed mutation as though nothing had occurred.
//
// This matters most where the tool is NOT idempotent: `humanMessage` advises
// retrying several of these codes, and a blind retry of a landed `move_task`
// is a second move.
export class WeeekWriteLandedError extends WeeekError {
  constructor(cause: WeeekError) {
    super({
      code: cause.code,
      message: cause.message,
      ...(cause.status !== undefined ? { status: cause.status } : {}),
      cause,
    });
    this.name = "WeeekWriteLandedError";
  }
}

// The mirror image of `WeeekWriteLandedError`: raised when an update names no
// field to change, BEFORE any request is issued. The whole point is the
// negative — no bytes leave the process — so it is raised at the transport
// seam rather than in the tool, where a second caller could bypass it.
//
// A `WeeekRequestNotSentError` (`src/weeek/types.ts`), so `humanMessage`
// renders "the request was not sent" rather than the `weeek_validation_error`
// sentence's "Weeek rejected the request", which would be untrue here.
export class WeeekEmptyUpdateError extends WeeekRequestNotSentError {
  constructor() {
    super("update called with no fields to change");
    this.name = "WeeekEmptyUpdateError";
  }
}

// I8 (#47) — the two terminal rungs of the MR-link field ladder (ADR 0005 §3).
// Both are `WeeekRequestNotSentError`s for the same reason
// `WeeekEmptyUpdateError` is: the write never leaves the process, so the agent
// must not be told Weeek rejected anything. What separates them is what the
// agent should do next, which is why they are two classes and not one flag —
// the tool turns each into a different sentence.
//
// **Neither message names a workspace field** (INVARIANT-2). Custom-field
// names are tenant data; the resolver has just read a list of them, and the
// only safe thing to say about that list is how many rows matched.
export class WeeekMrFieldNotFoundError extends WeeekRequestNotSentError {
  constructor() {
    super("no MR-link custom field resolved");
    this.name = "WeeekMrFieldNotFoundError";
  }
}

export class WeeekMrFieldAmbiguousError extends WeeekRequestNotSentError {
  constructor() {
    super("more than one custom field matched the MR-link name");
    this.name = "WeeekMrFieldAmbiguousError";
  }
}

// I8 (#43) — the task MUTATION endpoints. Kept apart from `tasks.ts` (the read
// side) because the two halves have different shapes: a read is one request
// whose body IS the answer, a write is a mutation whose answer must be read
// back. #44–#47 add `moveTask` / `updateTask` / `createTask` /
// `setTaskMrLink` alongside `completeTask` here.
//
// **Every write returns the resulting task**, in the exact `TaskDetail` shape
// `weeek_get_task` returns, so an agent never has to issue a follow-up read to
// see what it just did.

// Flip a task's completion flag.
//
// Transport: the two dedicated, POST-only routes. `PUT /tm/tasks/{id}` — the
// path `move_task` uses (probe #12) — was NOT chosen: whether it accepts a
// completion field is unverified, and a field a Weeek `PUT` ignores is
// accepted with a 200 (the `customFields`-array trap in probe #12 cost several
// probes exactly this way). The dedicated routes are documented for this one
// operation and were confirmed to exist on 2026-07-22 by a non-mutating
// differential probe: `GET` on both answers `405 allow: POST` (route present,
// POST-only) while `/uncomplete` answers 404.
//
// Two legs, because those routes answer `{"success":true}` and nothing else:
//
//   1. POST the completion route — bodyless; the target state is the path.
//   2. GET the task back — the resulting task the tool returns.
//
// The read-back is the *authoritative* answer, never a synthesis of the input:
// if the flag did not land, the agent sees `completed` as it really is. The
// cost is one extra GET per write; the benefit is that a write can never
// report a state the API does not hold.
//
// A failure on leg 2 still surfaces as an error, because there is no task to
// return — but as a `WeeekWriteLandedError`, so the tool can tell the agent the
// flag itself was written and only the read failed. Retrying is safe either
// way: the call sets an explicit target state (`idempotentHint: true`).
export async function completeTask(
  client: WeeekClient,
  id: number,
  completed: boolean,
): Promise<TaskDetail> {
  const action = completed ? "complete" : "un-complete";
  const raw = await client.request({
    method: "POST",
    path: `/tm/tasks/${String(id)}/${action}`,
  });
  parseWeeekAck(raw.status, raw.body);
  try {
    return await getTask(client, id);
  } catch (err) {
    if (err instanceof WeeekError) throw new WeeekWriteLandedError(err);
    throw err;
  }
}

// A board column IS a status in Weeek, so a column change is a status change.
// `boardColumnId` is required and `boardId` is not: a column alone moves the
// task within its current board, and a board alone is not expressible — a
// cross-board move must name a column that lives on the destination board
// (probe #12), and Weeek would otherwise pick one for us.
export interface MoveTaskArgs {
  boardColumnId: number;
  boardId?: number;
}

// Move a task to another column, optionally on another board.
//
// Transport: `PUT /tm/tasks/{id}`, the non-deprecated update path — NOT the
// dedicated `POST /tm/tasks/{id}/board[-column]` endpoints. Probe #12 pinned
// the choice: the `PUT` performs both the same-board column change and the
// cross-board re-parent (a 200 that re-parents, not a 4xx), and answers with
// the full updated task, where the dedicated endpoints answer with a minimal
// body carrying no task (`{success:true}` from `board-column`;
// `{success:true, boardId, boardColumnId}` from `board`) and are deprecated
// besides.
//
// **Recorded liability (API-03).** The `boardId` / `boardColumnId` body
// parameters this writes were deprecated upstream on 2025-05-18 in favour of a
// `locations[]` structure, with a grace period that expired around
// 2025-06-17. The live API still honours them and the replacement WRITE shape
// is unprobed — so we ship on the parameters that demonstrably work and track
// the migration rather than guessing at a shape we have never seen answer 200.
export async function moveTask(
  client: WeeekClient,
  id: number,
  args: MoveTaskArgs,
): Promise<TaskDetail> {
  // Built key-by-key rather than spread from `args`: the body is the whole
  // contract of this call, and an absent `boardId` must mean "same board",
  // never a `boardId` key at all. (Pinned with `toStrictEqual`, which does not
  // ignore an `undefined`-valued key the way `toEqual` would.)
  const body: Record<string, number> = {};
  if (args.boardId !== undefined) body["boardId"] = args.boardId;
  body["boardColumnId"] = args.boardColumnId;
  const raw = await client.request({
    method: "PUT",
    path: `/tm/tasks/${String(id)}`,
    body,
  });
  return parseWriteEcho(MOVE_ENDPOINT, raw);
}

// Parse the task a single-leg write echoes back, splitting the failure by
// status — the two cases mean opposite things to an agent. A non-2xx says the
// mutation did NOT land, so its error passes through as the truth it is. A 2xx
// we cannot parse says it DID land and we merely cannot show the result;
// that becomes a `WeeekWriteLandedError`, because both callers are
// `idempotentHint: false` and a blind retry would mutate a second time.
function parseWriteEcho(
  endpoint: string,
  raw: WeeekRawResponse,
): TaskDetail {
  try {
    return parseTaskDetailResponse(endpoint, raw);
  } catch (err) {
    const landed = raw.status >= 200 && raw.status < 300;
    if (landed && err instanceof WeeekError) {
      throw new WeeekWriteLandedError(err);
    }
    throw err;
  }
}

// The update surface: four fields, every one optional, at least one required
// (see `updateTask`). Deliberately NOT a mirror of `CreateTaskArgs` — probe
// #46 (2026-07-22) round-tripped each candidate field through
// `PUT /tm/tasks/{id}` and a re-`GET`, and only these four actually change
// anything:
//
//   title      → persists. An EMPTY title is accepted and stores `title: null`,
//                so the tool schema's `min(1)` is the only guard.
//   priority   → persists (including `0`), and an explicit `null` CLEARS it.
//   type       → persists. `null` is ignored — an enum with a default has no
//                "unset" state to return to.
//   dueDate    → persists (`Y-m-d`), and an explicit `null` CLEARS it.
//
// `null` is therefore a supplied value with a meaning on two of the four
// fields, not a synonym for "omitted" (probe #46f) — the same distinction
// `priority: 0` needs, one level up. Without it an agent could set a due date
// and never take it back off, a capability the API has and the tool would not.
//
// Three candidates were dropped for the same reason, and it is the reason this
// interface is hand-built rather than derived from the create side:
//
//   description → **accepted with 200 and silently ignored.** Not clobbered,
//                 not stored — the pre-existing value simply survives. No
//                 spelling works (`content`, `text`, `descriptionHtml`,
//                 `body`, `desc`), there is no `/tm/tasks/{id}/description`
//                 route (404), and the path allows no `PATCH`
//                 (`allow: GET,HEAD,PUT,DELETE`). Not editable through Public
//                 API v1 at all — the `customFields`-array trap (probe #12)
//                 in its purest form, and exactly what an unprobed schema
//                 would have shipped looking like it worked.
//   assignees   → also ignored on `PUT`. It has its own route,
//                 `POST /tm/tasks/{id}/assignees` (+ a `DELETE` sibling),
//                 whose semantics are ADD/REMOVE, not SET: an empty list is a
//                 422, and re-POSTing an existing member is a no-op. That is
//                 a different tool's shape, not a field of this one.
//   isCompleted → ignored on `PUT`. The completion flag belongs to
//                 `weeek_complete_task` and its dedicated routes anyway.
export interface UpdateTaskArgs {
  title?: string;
  // `null` clears; absent leaves alone. The two are different requests.
  priority?: number | null;
  type?: TaskType;
  dueDate?: string | null;
}

// Edit an existing task's fields.
//
// Transport: `PUT /tm/tasks/{id}` — the same path `moveTask` writes to, which
// is why the two tools' input surfaces are kept disjoint at the schema level
// rather than merged: one endpoint does not have to mean one tool, and an
// agent that cannot express "move" here cannot fire it by accident.
//
// **Only the named fields are sent.** Probe #46 confirmed the API leaves an
// unnamed field untouched, so an edit never clobbers what the agent did not
// mention — provided we never put a key on the wire for a field it did not
// name, which is what the key-by-key build below guarantees.
//
// **An empty update issues no request.** `PUT` with `{}` answers 200 and
// changes nothing (probe #46), so the round-trip is pure waste — and worse, a
// 200 would tell the agent its edit succeeded. Refused locally instead.
export async function updateTask(
  client: WeeekClient,
  id: number,
  args: UpdateTaskArgs,
): Promise<TaskDetail> {
  // Key-by-key, not a spread: `{...args}` would put `title: undefined` on the
  // body for every un-named field, and "absent" vs "present and undefined" is
  // the entire difference between a targeted edit and a blanket overwrite.
  // (Pinned with `toStrictEqual`, which does not ignore `undefined` values.)
  const body: Record<string, unknown> = {};
  if (args.title !== undefined) body["title"] = args.title;
  // `!== undefined` rather than truthiness, and it now carries two meanings at
  // once: priority 0 is "Low", not "unset", AND priority null is "unset", not
  // "unmentioned". Both survive only because the test is against `undefined`.
  if (args.priority !== undefined) body["priority"] = args.priority;
  if (args.type !== undefined) body["type"] = args.type;
  if (args.dueDate !== undefined) body["dueDate"] = args.dueDate;
  // Key COUNT, not truthiness — `{dueDate: null}` is a real edit ("clear it"),
  // and a truthiness test here would make clearing unreachable.
  if (Object.keys(body).length === 0) throw new WeeekEmptyUpdateError();
  const raw = await client.request({
    method: "PUT",
    path: `/tm/tasks/${String(id)}`,
    body,
  });
  return parseWriteEcho(UPDATE_ENDPOINT, raw);
}

// The create surface. Two required fields and seven optionals, every one of
// them live-probed against `POST /tm/tasks` on 2026-07-22 (#45) — nothing here
// is carried over from documentation alone, because a Weeek write accepts an
// unknown field with a 200 and silently ignores it (the `customFields`-array
// trap, probe #12), so an unverified field would look like it worked.
//
// `title` and `projectId` are required HERE and not by the API: the probe
// showed `POST /tm/tasks` answering 200 to a body with neither, producing a
// task with `title: null` (an untitled card) or `projectId: null` (a task in
// no project at all). Requiring them is the tool's own guard against filing
// junk into a live workspace, not an echo of an upstream constraint.
export interface CreateTaskArgs {
  title: string;
  projectId: number;
  description?: string;
  type?: TaskType;
  priority?: number;
  boardId?: number;
  boardColumnId?: number;
  assignees?: readonly string[];
  dueDate?: string;
}

// Create a task.
//
// Transport: `POST /tm/tasks` — the same path the list read uses, under the
// write verb. It answers with the full new task under the usual `task`
// envelope key (probe #45), so the caller gets the new id without a read-back.
//
// **Recorded liability (API-03).** `projectId` as a create-body parameter was
// deprecated upstream on 2025-05-18 in favour of the `locations[]` structure,
// with a grace period that expired around 2025-06-17. The probe confirms the
// live API still honours it (200, and `locations[0].projectId` reflects the
// value); the replacement WRITE shape has never been seen to answer 200. Same
// call as `moveTask` makes on the same liability: ship what demonstrably
// works, track the migration.
export async function createTask(
  client: WeeekClient,
  args: CreateTaskArgs,
): Promise<TaskDetail> {
  // Built key-by-key rather than spread from `args`: an absent optional must
  // be absent from the wire entirely, so Weeek applies its own default. A
  // spread would put `"description": undefined` in the object, and
  // `JSON.stringify` dropping that key is a coincidence this contract should
  // not rest on — `assignees: []` is a *supplied* empty list and must survive.
  // (Pinned with `toStrictEqual`, which does not ignore an `undefined`-valued
  // key the way `toEqual` would.)
  const body: Record<string, unknown> = {
    title: args.title,
    projectId: args.projectId,
  };
  if (args.description !== undefined) body["description"] = args.description;
  if (args.type !== undefined) body["type"] = args.type;
  // `!== undefined`, never truthiness: priority 0 is "Low", not "unset".
  if (args.priority !== undefined) body["priority"] = args.priority;
  if (args.boardId !== undefined) body["boardId"] = args.boardId;
  if (args.boardColumnId !== undefined) {
    body["boardColumnId"] = args.boardColumnId;
  }
  if (args.assignees !== undefined) body["assignees"] = [...args.assignees];
  if (args.dueDate !== undefined) body["dueDate"] = args.dueDate;
  const raw = await client.request({ method: "POST", path: "/tm/tasks", body });
  return parseWriteEcho(CREATE_ENDPOINT, raw);
}

// The names a workspace's MR-link custom field is looked for under when the
// caller names neither an id nor a name (ADR 0005 §3 rung 1). Matched
// case-insensitively after trimming, so "mr link" and "MR Link" are the same
// field to us and Weeek's own capitalisation does not matter.
//
// Both vocabularies are here on purpose: a GitLab shop says "merge request",
// a GitHub shop says "pull request", and an operator should not have to know
// which one this server was written by. The list is EXPORTED so the tool's
// description and `docs/weeek-api-notes.md` quote the same constant the
// resolver matches — a candidate list published in prose and matched in code
// is two lists. (The READMEs publish it at the I8 seal, #50, which owns the
// whole doc sync for the write set.)
//
// It stays short deliberately. Every extra name widens the chance that a
// workspace holds two matching fields, which is an error (§3), not a guess.
export const MR_LINK_FIELD_NAMES = [
  "MR link",
  "MR URL",
  "Merge request",
  "Merge request URL",
  "PR link",
  "Pull request",
] as const;

// The field types whose value is written as a plain string (ADR 0005 §2). A
// name match alone is not enough to write into a field: a `number`-typed field
// that someone called "MR link" would take a URL string and — at best — 422,
// at worst answer 200 and drop it, which is the very failure mode this tool is
// built around. Resolution therefore requires BOTH the name and a type that
// can hold the value.
//
// The cost is that a link-ish field of some type spelling we have never seen
// reads as "no MR-link field defined". That failure is loud and carries its
// own remedy (name the field's UUID with `custom_field_id`, which skips the
// listing and this filter entirely); writing into a field that cannot hold the
// value is silent, and silence is what there is no recovering from.
const STRING_VALUED_FIELD_TYPES = new Set(["link", "text"]);

// Case-insensitive, whitespace-insensitive comparison key, used for both field
// names and field types. `toLowerCase` is locale-independent here by design —
// these are ASCII identifiers, and a locale-sensitive fold would make
// resolution depend on the server's locale.
function foldKey(value: string): string {
  return value.trim().toLowerCase();
}

// The MR-link write surface. `url` is the value; the other two are the two
// upper rungs of the resolution ladder, and an id makes the whole listing
// round-trip disappear.
export interface SetTaskMrLinkArgs {
  url: string;
  // Rung 2 — the field's UUID. Skips the listing entirely.
  customFieldId?: string;
  // Rung 1 with an override — this name instead of `MR_LINK_FIELD_NAMES`.
  customFieldName?: string;
}

// Resolve which custom field to write into. Runs ONLY when no id was supplied,
// which is what makes "an id issues no listing request" true rather than
// merely intended.
//
// One rule for both the explicit-name and candidate-list cases: collect every
// field whose name matches, then require exactly one. Zero is "no MR-link
// field is defined here", two is an ambiguity the caller must settle — never a
// pick by list order, which would silently write to whichever field happened
// to be listed first and look identical to a correct resolution.
async function resolveMrLinkFieldId(
  client: WeeekClient,
  explicitName: string | undefined,
): Promise<string> {
  const wanted = new Set(
    (explicitName === undefined
      ? (MR_LINK_FIELD_NAMES as readonly string[])
      : [explicitName]
    ).map(foldKey),
  );
  const fields = await listCustomFields(client);
  // `id !== ""` is not paranoia: tolerant shaping (ADR 0003) degrades a
  // drifted id to `""`, and `{customFields: {"": url}}` is another body Weeek
  // takes with a 200 and discards — the exact silent no-op this tool is built
  // to avoid, arriving through the back door.
  // Destructured rather than length-checked so "exactly one" is expressed
  // without an unreachable index-access fallback: no first match is rung 3, a
  // second match is the ambiguity.
  const [first, second] = fields.filter(
    (f) =>
      f.id !== "" &&
      wanted.has(foldKey(f.name)) &&
      STRING_VALUED_FIELD_TYPES.has(foldKey(f.type)),
  );
  if (first === undefined) throw new WeeekMrFieldNotFoundError();
  if (second !== undefined) throw new WeeekMrFieldAmbiguousError();
  return first.id;
}

// Record a merge-request URL on the task that tracks it.
//
// Transport: `PUT /tm/tasks/{id}` — the same path `moveTask` and `updateTask`
// write to, with a body key disjoint from both (ADR 0005 §2). There is no
// dedicated task-custom-field route: `PUT`/`POST /tm/tasks/{id}/custom-fields`
// answers 404 (probe #12).
//
// **THE load-bearing fact: the body is a MAP keyed by field id, never an
// array.** A task READS its custom fields back as an array
// (`customFields: [{id, name, type, value}]`), so the array is the shape one
// would naturally write — and `PUT` with `customFields: [{id, value}]` answers
// **200 while silently discarding the value**; the field stays `null`. The
// status code cannot tell the two apart, which is why the map construction is
// pinned by an assertion on the recorded request body
// (`tests/weeek/endpoints/tasksWrite.test.ts`) rather than by a green
// response, and why this comment sits on the line that builds it.
//
// A mock can prove the bytes we send; it structurally cannot prove Weeek
// stored them. That second half — write the map, re-`GET` the task, assert the
// value is present — is the round-trip ADR 0005 gates on, and it belongs to
// the live write-cycle harness (#49, which lists it as its own acceptance
// criterion and is blocked on this ticket).
//
// For a `link` (or `text`) field the value is the plain URL string — no
// wrapper object, no `{value: …}`.
export async function setTaskMrLink(
  client: WeeekClient,
  id: number,
  args: SetTaskMrLinkArgs,
): Promise<TaskDetail> {
  const fieldId =
    args.customFieldId ??
    (await resolveMrLinkFieldId(client, args.customFieldName));
  // A MAP: field id → value. NOT `customFields: [{ id: fieldId, value: url }]`,
  // which is accepted with a 200 and ignored (see above).
  const body = { customFields: { [fieldId]: args.url } };
  const raw = await client.request({
    method: "PUT",
    path: `/tm/tasks/${String(id)}`,
    body,
  });
  return parseWriteEcho(SET_MR_LINK_ENDPOINT, raw);
}
