import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

// Single registration point. `ping` is ctx-free; Weeek tools take the
// ToolContext closure (config + client). Add new tool registrations here.
//
// INVARIANT: each `name` below MUST match the first argument passed to
// `server.registerTool(...)` inside the corresponding *.tool.ts file. Both
// the READ_ONLY and the ENABLED_TOOLS gates log by this name when skipping
// a registration, and the ENABLED_TOOLS preflight emits WARN by this name
// for unknown entries — a mismatch would silently lie to the operator.
export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  const entries: ReadonlyArray<{
    name: string;
    readOnly: boolean;
    register: () => void;
  }> = [
    { name: "ping", readOnly: true, register: () => registerPingTool(server) },
    {
      name: "weeek_get_me",
      readOnly: true,
      register: () => registerWeeekGetMeTool(server, ctx),
    },
    {
      name: "weeek_list_projects",
      readOnly: true,
      register: () => registerWeeekListProjectsTool(server, ctx),
    },
    {
      name: "weeek_get_project",
      readOnly: true,
      register: () => registerWeeekGetProjectTool(server, ctx),
    },
    {
      name: "weeek_list_tasks",
      readOnly: true,
      register: () => registerWeeekListTasksTool(server, ctx),
    },
    {
      name: "weeek_get_task",
      readOnly: true,
      register: () => registerWeeekGetTaskTool(server, ctx),
    },
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
      register: () => registerWeeekCompleteTaskTool(server, ctx),
    },
    {
      name: "weeek_move_task",
      readOnly: false,
      register: () => registerWeeekMoveTaskTool(server, ctx),
    },
    {
      name: "weeek_create_task",
      readOnly: false,
      register: () => registerWeeekCreateTaskTool(server, ctx),
    },
    {
      name: "weeek_update_task",
      readOnly: false,
      register: () => registerWeeekUpdateTaskTool(server, ctx),
    },
    {
      name: "weeek_set_task_mr_link",
      readOnly: false,
      register: () => registerWeeekSetTaskMrLinkTool(server, ctx),
    },
    {
      name: "weeek_list_members",
      readOnly: true,
      register: () => registerWeeekListMembersTool(server, ctx),
    },
    {
      name: "weeek_list_tags",
      readOnly: true,
      register: () => registerWeeekListTagsTool(server, ctx),
    },
    {
      name: "weeek_list_boards",
      readOnly: true,
      register: () => registerWeeekListBoardsTool(server, ctx),
    },
    {
      name: "weeek_list_board_columns",
      readOnly: true,
      register: () => registerWeeekListBoardColumnsTool(server, ctx),
    },
  ];
  const allowlist = ctx.config.enabledTools;

  if (allowlist) {
    // Surface typos in the user-supplied list. Iterate `allowlist` (not
    // `entries`), so an unknown name is named explicitly — not implied by
    // «every other tool was skipped». WARN-not-fatal: an operator may keep
    // a name that targets a tool from a future increment, and rolling out
    // the next branch should not require an env edit on every machine.
    const knownNames = new Set(entries.map((e) => e.name));
    for (const name of allowlist) {
      if (!knownNames.has(name)) {
        logger.warn("unknown tool in ENABLED_TOOLS", { name });
      }
    }
  }

  let registered = 0;
  for (const e of entries) {
    if (ctx.config.readOnly && !e.readOnly) {
      logger.info("tool gated by READ_ONLY", { name: e.name });
      continue;
    }
    if (allowlist && !allowlist.includes(e.name)) {
      logger.info("tool gated by ENABLED_TOOLS", { name: e.name });
      continue;
    }
    e.register();
    registered++;
  }

  if (registered === 0) {
    // Fail-closed-loud: a server with zero tools is almost always a config
    // mistake (typo in ENABLED_TOOLS, READ_ONLY hiding everything before
    // write tools land). Throwing here happens before `server.connect()` in
    // index.ts, so stdio never opens and the operator gets a clean
    // `fatal: main() rejected` instead of a silent, useless server.
    throw new Error(
      "no tools registered: combination of READ_ONLY and ENABLED_TOOLS hides every tool",
    );
  }
}
