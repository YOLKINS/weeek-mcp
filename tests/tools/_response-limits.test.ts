import { describe, it, expect } from "vitest";
import {
  applyResponseLimits,
  type ErrorPayload,
} from "../../src/tools/_response-limits.js";
import { makeSuccessPayload } from "../helpers/factories.js";

const MARKER = "…[truncated]";

interface MiniTask {
  id: number;
  title: string;
  completed: boolean;
  projectId: number;
  priority: number;
  type: string;
}

function makeTasks(n: number): MiniTask[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    title: `task-${String(i)}`,
    completed: false,
    projectId: 1,
    priority: 1,
    type: "task",
  }));
}

describe("applyResponseLimits", () => {
  it("returns the same reference for error payloads", () => {
    const payload: ErrorPayload = {
      content: [
        {
          type: "text",
          text: "weeek_list_tasks failed (weeek_unauthorized): Weeek rejected the access token (HTTP 401).",
        },
      ],
      isError: true,
    };
    const out = applyResponseLimits("weeek_list_tasks", payload, {
      maxResponseChars: 100,
    });
    expect(out).toBe(payload);
  });

  it("returns identity for unknown tool names", () => {
    const payload = makeSuccessPayload({ x: "y".repeat(10000) });
    const out = applyResponseLimits("weeek_unknown", payload, {
      maxResponseChars: 1024,
    });
    expect(out).toBe(payload);
  });

  it("weeek_list_projects fits the budget without truncation", () => {
    const projects = [
      { id: 1, title: "alpha", color: "#fff", isPrivate: false },
      { id: 2, title: "beta", color: "#000", isPrivate: true },
      { id: 3, title: "gamma", color: "#abc", isPrivate: false },
    ];
    const payload = makeSuccessPayload({ projects });
    const out = applyResponseLimits("weeek_list_projects", payload, {
      maxResponseChars: 65536,
    });
    expect(out.isError).not.toBe(true);
    if (out.isError === true) throw new Error("unreachable");
    const sc = out.structuredContent as { projects: unknown[]; truncated: boolean };
    expect(sc.truncated).toBe(false);
    expect(sc.projects).toHaveLength(3);
    expect(JSON.stringify(sc).length).toBeLessThan(65536);
  });

  it("weeek_list_tasks clips items when budget is tight", () => {
    const tasks = makeTasks(100);
    const payload = makeSuccessPayload({ tasks, hasMore: false });
    const out = applyResponseLimits("weeek_list_tasks", payload, {
      maxResponseChars: 1024,
    });
    if (out.isError === true) throw new Error("unreachable");
    const sc = out.structuredContent as {
      tasks: MiniTask[];
      hasMore: boolean;
      truncated: boolean;
    };
    expect(sc.truncated).toBe(true);
    expect(sc.tasks.length).toBeLessThan(100);
    expect(JSON.stringify(sc).length).toBeLessThanOrEqual(1024);
  });

  it("binary search finds the largest fitting prefix (off-by-one guard)", () => {
    const tasks = makeTasks(100);
    const payload = makeSuccessPayload({ tasks, hasMore: false });
    const budget = 1024;
    const out = applyResponseLimits("weeek_list_tasks", payload, {
      maxResponseChars: budget,
    });
    if (out.isError === true) throw new Error("unreachable");
    const sc = out.structuredContent as {
      tasks: MiniTask[];
      hasMore: boolean;
      truncated: boolean;
    };
    const k = sc.tasks.length;
    expect(JSON.stringify(sc).length).toBeLessThanOrEqual(budget);

    if (k < tasks.length) {
      const oversized = {
        tasks: tasks.slice(0, k + 1),
        hasMore: false,
        truncated: true,
      };
      expect(JSON.stringify(oversized).length).toBeGreaterThan(budget);
    }
  });

  it("defensive branch when list key is not an array", () => {
    const payload = makeSuccessPayload({
      members: undefined as unknown as never,
      otherField: "x",
    });
    const out = applyResponseLimits("weeek_list_members", payload, {
      maxResponseChars: 65536,
    });
    if (out.isError === true) throw new Error("unreachable");
    const sc = out.structuredContent as Record<string, unknown>;
    expect(sc["truncated"]).toBe(false);
    expect(sc["otherField"]).toBe("x");
  });

  it("weeek_get_task with short description fits without truncation", () => {
    const payload = makeSuccessPayload({
      id: 1,
      title: "t",
      description: "hello",
      completed: false,
      projectId: 1,
      priority: 1,
      type: "task",
    });
    const out = applyResponseLimits("weeek_get_task", payload, {
      maxResponseChars: 65536,
    });
    if (out.isError === true) throw new Error("unreachable");
    const sc = out.structuredContent as unknown as {
      description: string;
      truncated: boolean;
    };
    expect(sc.truncated).toBe(false);
    expect(sc.description).toBe("hello");
  });

  it("weeek_get_task clips long description and appends marker", () => {
    const payload = makeSuccessPayload({
      id: 1,
      title: "t",
      description: "x".repeat(50_000),
      completed: false,
      projectId: 1,
      priority: 1,
      type: "task",
    });
    const out = applyResponseLimits("weeek_get_task", payload, {
      maxResponseChars: 2048,
    });
    if (out.isError === true) throw new Error("unreachable");
    const sc = out.structuredContent as unknown as {
      description: string;
      truncated: boolean;
    };
    expect(sc.truncated).toBe(true);
    expect(sc.description.endsWith(MARKER)).toBe(true);
    expect(JSON.stringify(sc).length).toBeLessThanOrEqual(2048);
  });

  it("weeek_get_task with description=null falls back to identity branch", () => {
    const payload = makeSuccessPayload({
      id: 1,
      title: "x".repeat(2000),
      description: null,
      completed: false,
      projectId: 1,
      priority: 1,
      type: "task",
    });
    const out = applyResponseLimits("weeek_get_task", payload, {
      maxResponseChars: 1024,
    });
    if (out.isError === true) throw new Error("unreachable");
    const sc = out.structuredContent as unknown as {
      description: string | null;
      truncated: boolean;
    };
    expect(sc.description).toBeNull();
    expect(sc.truncated).toBe(true);
  });

  it("weeek_get_task: marker-only fallback when even fits(0) is false", () => {
    const payload = makeSuccessPayload({
      id: 1,
      title: "title",
      description: "any",
      completed: false,
      projectId: 1,
      priority: 1,
      type: "task",
    });
    const out = applyResponseLimits("weeek_get_task", payload, {
      maxResponseChars: 64,
    });
    if (out.isError === true) throw new Error("unreachable");
    const sc = out.structuredContent as unknown as {
      description: string;
      truncated: boolean;
    };
    expect(sc.description).toBe(MARKER);
    expect(sc.truncated).toBe(true);
  });

  it("weeek_get_task tolerates surrogate pairs in description", () => {
    const payload = makeSuccessPayload({
      id: 1,
      title: "t",
      description: "😀".repeat(2000),
      completed: false,
      projectId: 1,
      priority: 1,
      type: "task",
    });
    const out = applyResponseLimits("weeek_get_task", payload, {
      maxResponseChars: 512,
    });
    if (out.isError === true) throw new Error("unreachable");
    const sc = out.structuredContent as unknown as {
      description: string;
      truncated: boolean;
    };
    expect(sc.description.endsWith(MARKER)).toBe(true);
    const json = JSON.stringify(sc);
    expect(() => {
      JSON.parse(json);
    }).not.toThrow();
  });

  it("weeek_list_tags with empty list keeps truncated=false", () => {
    const payload = makeSuccessPayload({ tags: [] as unknown[] });
    const out = applyResponseLimits("weeek_list_tags", payload, {
      maxResponseChars: 1024,
    });
    if (out.isError === true) throw new Error("unreachable");
    const sc = out.structuredContent as { tags: unknown[]; truncated: boolean };
    expect(sc.truncated).toBe(false);
    expect(sc.tags).toEqual([]);
  });

  it("weeek_list_boards fits the budget without truncation", () => {
    const boards = [
      { id: 1, name: "Backlog", projectId: 5, isPrivate: false },
      { id: 2, name: "Sprint", projectId: 5, isPrivate: true },
    ];
    const payload = makeSuccessPayload({ boards });
    const out = applyResponseLimits("weeek_list_boards", payload, {
      maxResponseChars: 65536,
    });
    if (out.isError === true) throw new Error("unreachable");
    const sc = out.structuredContent as { boards: unknown[]; truncated: boolean };
    expect(sc.truncated).toBe(false);
    expect(sc.boards).toHaveLength(2);
  });

  it("weeek_list_boards clips items when budget is tight", () => {
    const boards = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      name: "B".repeat(60),
      projectId: 5,
      isPrivate: false,
    }));
    const payload = makeSuccessPayload({ boards });
    const out = applyResponseLimits("weeek_list_boards", payload, {
      maxResponseChars: 1024,
    });
    if (out.isError === true) throw new Error("unreachable");
    const sc = out.structuredContent as { boards: unknown[]; truncated: boolean };
    expect(sc.truncated).toBe(true);
    expect(sc.boards.length).toBeLessThan(100);
    expect(JSON.stringify(sc).length).toBeLessThanOrEqual(1024);
  });

  it("weeek_list_board_columns fits the budget without truncation", () => {
    const boardColumns = [
      { id: 1, name: "Todo", boardId: 7 },
      { id: 2, name: "Done", boardId: 7 },
    ];
    const payload = makeSuccessPayload({ boardColumns });
    const out = applyResponseLimits("weeek_list_board_columns", payload, {
      maxResponseChars: 65536,
    });
    if (out.isError === true) throw new Error("unreachable");
    const sc = out.structuredContent as {
      boardColumns: unknown[];
      truncated: boolean;
    };
    expect(sc.truncated).toBe(false);
    expect(sc.boardColumns).toHaveLength(2);
  });

  it("weeek_list_board_columns clips items when budget is tight", () => {
    const boardColumns = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      name: "C".repeat(60),
      boardId: 7,
    }));
    const payload = makeSuccessPayload({ boardColumns });
    const out = applyResponseLimits("weeek_list_board_columns", payload, {
      maxResponseChars: 1024,
    });
    if (out.isError === true) throw new Error("unreachable");
    const sc = out.structuredContent as {
      boardColumns: unknown[];
      truncated: boolean;
    };
    expect(sc.truncated).toBe(true);
    expect(sc.boardColumns.length).toBeLessThan(100);
  });

  it("does not mutate the input payload", () => {
    const tasks = makeTasks(100);
    const tasksRef = tasks;
    const payload = makeSuccessPayload({ tasks, hasMore: false });
    applyResponseLimits("weeek_list_tasks", payload, { maxResponseChars: 1024 });
    expect(payload.structuredContent.tasks).toBe(tasksRef);
    expect(payload.structuredContent.tasks).toHaveLength(100);
    expect("truncated" in payload.structuredContent).toBe(false);
  });
});
