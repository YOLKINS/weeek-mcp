// Barrel re-export. Per-resource modules under src/weeek/endpoints/*.ts keep
// each tool's parser + request co-located; tools and tests import from this
// path so the split is invisible to callers.

export { getMe } from "./endpoints/users.js";
export { listProjects } from "./endpoints/projects.js";
export { getProject } from "./endpoints/projectDetail.js";
export { listTasks, getTask, type ListTasksArgs } from "./endpoints/tasks.js";
export {
  completeTask,
  createTask,
  moveTask,
  setTaskMrLink,
  updateTask,
  MR_LINK_FIELD_NAMES,
  TASK_TYPES,
  type CreateTaskArgs,
  type MoveTaskArgs,
  type SetTaskMrLinkArgs,
  type TaskType,
  type UpdateTaskArgs,
  WeeekEmptyUpdateError,
  WeeekMrFieldAmbiguousError,
  WeeekMrFieldNotFoundError,
  WeeekWriteLandedError,
} from "./endpoints/tasksWrite.js";
export { listBoards } from "./endpoints/boards.js";
export { listBoardColumns } from "./endpoints/boardColumns.js";
export { listMembers } from "./endpoints/members.js";
export { listTags } from "./endpoints/tags.js";
