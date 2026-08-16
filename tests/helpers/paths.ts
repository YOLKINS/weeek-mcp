// Weeek API paths used across the test surface. Centralised so an
// upstream rename touches one file instead of every endpoint / tool /
// invariant test. Keep in lockstep with `docs/weeek-api-notes.md` and
// the per-resource handlers in `src/weeek/endpoints/*.ts`.
export const WEEEK_PATH = {
  userMe: "/user/me",
  projectsList: "/tm/projects",
  projectById: (id: number | string): string =>
    `/tm/projects/${String(id)}`,
  tasksList: "/tm/tasks",
  taskById: (id: number | string): string => `/tm/tasks/${String(id)}`,
  // I8 (#43) — the two dedicated completion routes. Probe-confirmed
  // 2026-07-22 by a non-mutating differential `GET`: both answer
  // `405 allow: POST` (the route exists, POST-only) while `/uncomplete`
  // answers 404. See `docs/weeek-api-notes.md` § write endpoints.
  taskComplete: (id: number | string): string =>
    `/tm/tasks/${String(id)}/complete`,
  taskUnComplete: (id: number | string): string =>
    `/tm/tasks/${String(id)}/un-complete`,
  // I8 (#47) — the workspace's custom-field definitions. Used INTERNALLY by
  // `weeek_set_task_mr_link`'s by-name resolution only; no listing tool is
  // exposed, and `POST /tm/custom-fields` (field creation) is never called.
  // Probe #12: answers `{success:true, data:[{id,name,type}, …]}` — a `data`
  // array, not the empty object the published spec documents.
  customFieldsList: "/tm/custom-fields",
  membersList: "/ws/members",
  tagsList: "/ws/tags",
  boardsList: "/tm/boards",
  boardColumnsList: "/tm/board-columns",
} as const;
