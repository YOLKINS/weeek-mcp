import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EnvConfig } from "../config/env.js";
import type { ToolContext } from "../server/context.js";
import { logger } from "../logging/logger.js";
import { registerPingTool } from "./ping.tool.js";
import { registerWeeekGetMeTool } from "./users/getMe.tool.js";
import { registerWeeekListMembersTool } from "./users/listMembers.tool.js";
import { registerWeeekListProjectsTool } from "./projects/listProjects.tool.js";
import { registerWeeekGetProjectTool } from "./projects/getProject.tool.js";
import { registerWeeekListTasksTool } from "./tasks/listTasks.tool.js";
import { registerWeeekGetTaskTool } from "./tasks/getTask.tool.js";
import { registerWeeekCompleteTaskTool } from "./tasks/completeTask.tool.js";
import { registerWeeekMoveTaskTool } from "./tasks/moveTask.tool.js";
import { registerWeeekCreateTaskTool } from "./tasks/createTask.tool.js";
import { registerWeeekUpdateTaskTool } from "./tasks/updateTask.tool.js";
import { registerWeeekSetTaskMrLinkTool } from "./tasks/setTaskMrLink.tool.js";
import { registerWeeekListTagsTool } from "./tags/listTags.tool.js";
import { registerWeeekListBoardsTool } from "./boards/listBoards.tool.js";
import { registerWeeekListBoardColumnsTool } from "./boards/listBoardColumns.tool.js";

/**
 * What the gate decided about one tool. Deliberately not just a name: the
 * server's `instructions` string is built from this (see
 * `src/server/instructions.ts`) and has to state whether anything on the
 * surface can write, which a bare list of names cannot answer.
 */
export interface ToolSelection {
  readonly name: string;
  readonly readOnly: boolean;
}

interface ToolManifestEntry extends ToolSelection {
  /**
   * Takes `server` / `ctx` as parameters rather than closing over them, which
   * is the whole reason this table can live at module level — and therefore
   * the reason `selectTools` can run the gate BEFORE `new McpServer(...)`
   * exists to be closed over. `registerPingTool` ignores the second argument;
   * a narrower function is assignable here.
   */
  readonly register: (server: McpServer, ctx: ToolContext) => void;
}

// Single registration point, and the order a client sees on `tools/list`.
// `ping` is ctx-free; Weeek tools take the ToolContext (config + client). Add
// new tool registrations here.
//
// INVARIANT: each `name` below MUST match the first argument passed to
// `server.registerTool(...)` inside the corresponding *.tool.ts file. Both the
// READ_ONLY and the ENABLED_TOOLS gates log by this name when skipping a
// registration, the ENABLED_TOOLS preflight emits WARN by this name for
// unknown entries, and INVARIANT-14 checks the `instructions` prose against
// it — a mismatch would silently lie to the operator and to the agent.
const TOOL_MANIFEST: readonly ToolManifestEntry[] = [
  { name: "ping", readOnly: true, register: registerPingTool },
  { name: "weeek_get_me", readOnly: true, register: registerWeeekGetMeTool },
  {
    name: "weeek_list_projects",
    readOnly: true,
    register: registerWeeekListProjectsTool,
  },
  {
    name: "weeek_get_project",
    readOnly: true,
    register: registerWeeekGetProjectTool,
  },
  {
    name: "weeek_list_tasks",
    readOnly: true,
    register: registerWeeekListTasksTool,
  },
  { name: "weeek_get_task", readOnly: true, register: registerWeeekGetTaskTool },
  // I8 (#43) — the FIRST `readOnly: false` entry. Two consequences worth
  // stating where the flag lives: (1) this tool is invisible under the
  // default `READ_ONLY=true`, so the default install's surface is unchanged;
  // (2) INVARIANT-12 now binds — the flag here and
  // `annotations.readOnlyHint` in the tool file are a duplicate source of
  // truth and must stay exact negations (ADR 0004 §3). The write tools sit
  // inside the task group, after `weeek_get_task`, so the by-resource
  // grouping of the read surface survives.
  {
    name: "weeek_complete_task",
    readOnly: false,
    register: registerWeeekCompleteTaskTool,
  },
  {
    name: "weeek_move_task",
    readOnly: false,
    register: registerWeeekMoveTaskTool,
  },
  {
    name: "weeek_create_task",
    readOnly: false,
    register: registerWeeekCreateTaskTool,
  },
  {
    name: "weeek_update_task",
    readOnly: false,
    register: registerWeeekUpdateTaskTool,
  },
  {
    name: "weeek_set_task_mr_link",
    readOnly: false,
    register: registerWeeekSetTaskMrLinkTool,
  },
  {
    name: "weeek_list_members",
    readOnly: true,
    register: registerWeeekListMembersTool,
  },
  { name: "weeek_list_tags", readOnly: true, register: registerWeeekListTagsTool },
  {
    name: "weeek_list_boards",
    readOnly: true,
    register: registerWeeekListBoardsTool,
  },
  {
    name: "weeek_list_board_columns",
    readOnly: true,
    register: registerWeeekListBoardColumnsTool,
  },
];

/**
 * Run the READ_ONLY / ENABLED_TOOLS gates and return the surviving surface, in
 * registration order.
 *
 * 1.0.1 split this out of `registerAllTools` for one reason: the
 * `instructions` string is an option to the `McpServer` CONSTRUCTOR, so it has
 * to be built before a server exists — while `registerAllTools` necessarily
 * runs after. Deriving the prose from the gate therefore requires the gate to
 * be callable on its own. This function is the whole of it: same two checks,
 * same order, same log lines, same fail-closed throw. `registerAllTools`
 * defaults to calling it, so every existing caller is unaffected and the gate
 * still runs exactly once per boot.
 *
 * Emits log lines as a side effect; call it once and pass the result on.
 */
export function selectTools(config: EnvConfig): readonly ToolSelection[] {
  const allowlist = config.enabledTools;

  if (allowlist) {
    // Surface typos in the user-supplied list. Iterate `allowlist` (not the
    // manifest), so an unknown name is named explicitly — not implied by
    // «every other tool was skipped». WARN-not-fatal: an operator may keep
    // a name that targets a tool from a future increment, and rolling out
    // the next branch should not require an env edit on every machine.
    const knownNames = new Set(TOOL_MANIFEST.map((e) => e.name));
    for (const name of allowlist) {
      if (!knownNames.has(name)) {
        logger.warn("unknown tool in ENABLED_TOOLS", { name });
      }
    }
  }

  const selected: ToolSelection[] = [];
  for (const e of TOOL_MANIFEST) {
    if (config.readOnly && !e.readOnly) {
      logger.info("tool gated by READ_ONLY", { name: e.name });
      continue;
    }
    if (allowlist && !allowlist.includes(e.name)) {
      logger.info("tool gated by ENABLED_TOOLS", { name: e.name });
      continue;
    }
    selected.push({ name: e.name, readOnly: e.readOnly });
  }

  if (selected.length === 0) {
    // Fail-closed-loud: a server with zero tools is almost always a config
    // mistake (typo in ENABLED_TOOLS, READ_ONLY hiding every named tool).
    // Throwing here happens before `server.connect()` in index.ts — and now
    // before `new McpServer(...)` too — so stdio never opens and the operator
    // gets a clean `fatal: main() rejected` instead of a silent, useless
    // server.
    throw new Error(
      "no tools registered: combination of READ_ONLY and ENABLED_TOOLS hides every tool",
    );
  }
  return selected;
}

/**
 * Register the selected surface on `server`.
 *
 * `selected` defaults to running the gate, which keeps the two-argument call
 * used throughout the tests honest. `src/index.ts` passes the selection it
 * already computed for `instructions`, so the gate — and its log lines — run
 * exactly once.
 *
 * The loop walks the MANIFEST and filters by a set of chosen names rather than
 * walking `selected` and looking a registrar up by name. Two reasons: under
 * `noUncheckedIndexedAccess` a keyed lookup yields `fn | undefined` and an
 * invitation to write the double assertion CLAUDE.md forbids and
 * `tests/invariants/type-assertions.test.ts` greps for; and iterating the
 * manifest makes registration order a property of this file rather than of
 * whatever the caller happened to hand in.
 */
export function registerAllTools(
  server: McpServer,
  ctx: ToolContext,
  selected: readonly ToolSelection[] = selectTools(ctx.config),
): void {
  const chosen = new Set(selected.map((s) => s.name));
  for (const e of TOOL_MANIFEST) {
    if (chosen.has(e.name)) {
      e.register(server, ctx);
    }
  }
}
