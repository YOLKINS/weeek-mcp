// Stable, machine-readable error taxonomy for the Weeek HTTP client. Tools map
// these to `isError: true` content per MCP 2025-06-18 (no `McpError` for
// upstream failures — those are protocol-level errors, not tool-level ones).
export type WeeekErrorCode =
  | "weeek_unauthorized"
  | "weeek_forbidden"
  | "weeek_not_found"
  // I8 (#42): the request was well-formed HTTP but carried a value Weeek
  // rejected — "you sent something wrong", as opposed to
  // `weeek_invalid_response`'s "the API sent something unexpected". Mapped
  // from HTTP 400 AND 422; see `unwrap.codeForStatus` and `docs/errors.md`.
  | "weeek_validation_error"
  | "weeek_rate_limited"
  | "weeek_server_error"
  | "weeek_network"
  | "weeek_timeout"
  | "weeek_invalid_response";

export interface WeeekErrorOptions {
  code: WeeekErrorCode;
  message: string;
  status?: number;
  cause?: unknown;
}

// INVARIANT-2: WeeekError MUST NOT carry response body fragments — bodies may
// contain tenant data. `message` is a short, stable string built from the code
// and (optionally) the HTTP status, never from the response payload.
//
// Retry semantics are agent-side by design (RETRO-01): the server surfaces
// `weeek_<code>` in the error sentence and the agent decides whether to
// retry based on the code. The client does not retry, and `WeeekError` does
// not carry a `retryable` flag — the code itself is the contract.
export class WeeekError extends Error {
  readonly code: WeeekErrorCode;
  readonly status: number | undefined;

  constructor(opts: WeeekErrorOptions) {
    super(opts.message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "WeeekError";
    this.code = opts.code;
    this.status = opts.status;
  }
}

// I8 (#46) — a request the client refused to send, as opposed to one Weeek
// rejected. Every other `WeeekError` in the system is born from an HTTP
// response; this one is born from its absence, which is the whole point: an
// update naming no field to change would be a 200 no-op upstream (probe #46),
// so it never leaves the process.
//
// It lives HERE, beside `WeeekError`, rather than with the endpoint that
// raises it, because `humanMessage` renders its sentence and the mapper must
// not depend on an endpoint module. The code is `weeek_validation_error` —
// "you sent something wrong" (`docs/errors.md`) is exactly the situation, and
// a tenth code would ripple through the compile-time-exhaustive error matrix
// for one local guard.
//
// No `status`: there was no HTTP response to have one.
export class WeeekRequestNotSentError extends WeeekError {
  constructor(message: string) {
    super({ code: "weeek_validation_error", message });
    this.name = "WeeekRequestNotSentError";
  }
}

// Narrow subset of the Weeek `/user/me` payload. We expose only fields a tool
// caller is likely to need; full passthrough is deliberately avoided so that
// future Weeek API additions do not silently change our tool's output schema.
// `name` is derived in `endpoints.getMe` (Weeek returns firstName/lastName,
// not a single `name`), so callers can rely on it being present.
export interface MeResponse {
  id: number | string;
  email: string;
  name: string;
}

// I4 — read-only list/get tools. Each interface mirrors the documented field
// subset in `docs/weeek-api-notes.md` and matches the corresponding tool's
// `outputSchema`. Non-essential fields are intentionally omitted to avoid
// passthrough drift (same discipline as `MeResponse`).
export interface ProjectSummary {
  id: number;
  title: string;
  color: string;
  isPrivate: boolean;
}

// Detail variant returned by `/tm/projects/{id}` (singular envelope key
// `project`). Extends the list-row shape with `description`, the only
// non-trivial variable-length field — same passthrough discipline as
// `TaskDetail` vs `TaskSummary`. `logoLink`, `team`, `customFields` are
// deliberately omitted (see `docs/weeek-api-notes.md`).
export interface ProjectDetail {
  id: number;
  title: string;
  description: string | null;
  color: string;
  isPrivate: boolean;
}

// I7 (session B) BREAK — `userId` (primary assignee UUID, nullable) +
// `assignees[]` (every assignee UUID, possibly empty) become required on
// both Task* shapes. Probe-confirmed string passthrough — no numeric
// coerce. The break rode the `0.2.0` read-parity minor bump.
export interface TaskSummary {
  id: number;
  title: string;
  // Sourced from the upstream `isCompleted` field (bug #25).
  completed: boolean;
  projectId: number;
  // `null` = no priority set upstream; passed through verbatim (bug #25).
  priority: number | null;
  type: string;
  userId: string | null;
  assignees: readonly string[];
}

export interface TaskListResponse {
  tasks: TaskSummary[];
  hasMore: boolean;
}

export interface TaskDetail {
  id: number;
  title: string;
  description: string | null;
  // Sourced from the upstream `isCompleted` field (bug #25).
  completed: boolean;
  projectId: number;
  // `null` = no priority set upstream; passed through verbatim (bug #25).
  priority: number | null;
  type: string;
  userId: string | null;
  assignees: readonly string[];
}

// I7 (session B) — `/tm/boards?projectId=<int>` element shape.
// Probe-confirmed: label is `name`, not `title` (diverges from
// `/tm/projects` and `/tm/tasks`); `isPrivate` present, no `isDefault`.
export interface BoardSummary {
  id: number;
  name: string;
  projectId: number;
  isPrivate: boolean;
}

// I7 (session B) — `/tm/board-columns?boardId=<int>` element shape.
// Path is hyphenated and query-param-scoped (not `/tm/boards/{id}/columns`).
// Three fields only: probe found no `position` / `type` / `sortOrder`;
// array order is the only sort signal — preserve verbatim.
export interface BoardColumnSummary {
  id: number;
  name: string;
  boardId: number;
}

export interface MemberSummary {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

export interface TagSummary {
  id: number;
  title: string;
  color: string;
}

// I8 (#47) — a `/tm/custom-fields` definition row. Read internally by
// `weeek_set_task_mr_link`'s by-name resolution and by nothing else: no
// listing tool is exposed (ADR 0005 §4), so this shape is never an
// `outputSchema` and is free to stay minimal.
//
// **`id` is a UUID string**, not the integer used for task / project / board /
// column ids (probe #12). It is the map key of the custom-fields write body,
// which is the whole reason this endpoint is read at all.
export interface CustomFieldSummary {
  id: string;
  name: string;
  // `link` and `text` both take a plain string value; other types exist and
  // are parsed but never written to by this server.
  type: string;
}
