// The registered tool surface, in registration order — one copy, imported by
// every test that needs to name it (registry gate tests, MCP invariants,
// outputSchema freeze).
//
// Extracted in I8 (#43): the same three lists had been hand-copied into three
// test files, which is precisely the drift INVARIANT-10/12 exist to prevent,
// re-created one level up in the tests themselves. A tool added to
// `src/tools/registry.ts` without touching this file fails the name-drift
// assertion in `tests/invariants/mcp.test.ts`, which is the intended tripwire.

// What a default install exposes (`READ_ONLY=true`).
export const READ_TOOLS = [
  "ping",
  "weeek_get_me",
  "weeek_list_projects",
  "weeek_get_project",
  "weeek_list_tasks",
  "weeek_get_task",
  "weeek_list_members",
  "weeek_list_tags",
  "weeek_list_boards",
  "weeek_list_board_columns",
] as const;

// The mutating tools, hidden unless `READ_ONLY=false`. Grew one entry per I8
// ticket (#43 → #47) and is closed at five by the seal (#50), which pins the
// literal counts — 10 under `READ_ONLY=true`, 15 under `READ_ONLY=false` — in
// `tests/tools/registry.test.ts` and, on the wire, in
// `tests/invariants/tools-list-wire.test.ts`. This list stays the single copy
// of the *names*; the counts are asserted as numerals so a list that silently
// lost an entry cannot make its own assertion pass.
export const WRITE_TOOLS = [
  "weeek_complete_task",
  "weeek_move_task",
  "weeek_create_task",
  "weeek_update_task",
  "weeek_set_task_mr_link",
] as const;

// Registration order interleaves the two: writes sit inside the task group,
// immediately after `weeek_get_task`, keeping the by-resource grouping the
// read surface established.
export const ALL_TOOLS = [
  "ping",
  "weeek_get_me",
  "weeek_list_projects",
  "weeek_get_project",
  "weeek_list_tasks",
  "weeek_get_task",
  ...WRITE_TOOLS,
  "weeek_list_members",
  "weeek_list_tags",
  "weeek_list_boards",
  "weeek_list_board_columns",
] as const;
