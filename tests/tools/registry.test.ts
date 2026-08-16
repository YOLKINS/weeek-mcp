import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerAllTools } from "../../src/tools/registry.js";
import { logger } from "../../src/logging/logger.js";
import type { LoggerMethodSpy } from "../helpers/spies.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../src/server/context.js";
import type { WeeekClient } from "../../src/weeek/client.js";
import { makeEnvConfig } from "../helpers/factories.js";
import { READ_TOOLS, WRITE_TOOLS, ALL_TOOLS } from "../helpers/toolNames.js";

interface FakeServer {
  server: McpServer;
  calls: () => string[];
}

function makeMockServer(): FakeServer {
  const fn = vi.fn();
  const server = { registerTool: fn } as unknown as McpServer;
  return {
    server,
    calls: () => fn.mock.calls.map((c) => c[0] as string),
  };
}

const dummyWeeek = { request: vi.fn() } as unknown as WeeekClient;

describe("registerAllTools", () => {
  let warnSpy: LoggerMethodSpy;
  let infoSpy: LoggerMethodSpy;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
  });

  it("registers exactly the read surface under defaults — writes are hidden", () => {
    const { server, calls } = makeMockServer();
    const ctx: ToolContext = { config: makeEnvConfig(), weeek: dummyWeeek };
    expect(() => registerAllTools(server, ctx)).not.toThrow();
    expect(calls()).toEqual([...READ_TOOLS]);
    expect(calls()).toHaveLength(10);
    for (const name of WRITE_TOOLS) {
      expect(calls()).not.toContain(name);
    }
  });

  it("respects the ENABLED_TOOLS allowlist (registration order, not allowlist order)", () => {
    const { server, calls } = makeMockServer();
    const ctx: ToolContext = {
      config: makeEnvConfig({ enabledTools: ["weeek_get_me", "ping"] }),
      weeek: dummyWeeek,
    };
    registerAllTools(server, ctx);
    expect(calls()).toEqual(["ping", "weeek_get_me"]);
  });

  it("warns once for an unknown name in the allowlist but still registers known names", () => {
    const { server, calls } = makeMockServer();
    const ctx: ToolContext = {
      config: makeEnvConfig({ enabledTools: ["weeek_get_me", "weeek_typo"] }),
      weeek: dummyWeeek,
    };
    registerAllTools(server, ctx);
    expect(calls()).toEqual(["weeek_get_me"]);
    const unknownWarns = warnSpy.mock.calls.filter(
      (c) => c[0] === "unknown tool in ENABLED_TOOLS",
    );
    expect(unknownWarns).toHaveLength(1);
    expect(unknownWarns[0]?.[1]).toEqual({ name: "weeek_typo" });
  });

  it("fails closed when the allowlist contains only unknown names", () => {
    const { server, calls } = makeMockServer();
    const ctx: ToolContext = {
      config: makeEnvConfig({ enabledTools: ["totally_unknown"] }),
      weeek: dummyWeeek,
    };
    expect(() => registerAllTools(server, ctx)).toThrow(/no tools registered/);
    expect(calls()).toHaveLength(0);
    const unknownWarns = warnSpy.mock.calls.filter(
      (c) => c[0] === "unknown tool in ENABLED_TOOLS",
    );
    expect(unknownWarns).toHaveLength(1);
    expect(unknownWarns[0]?.[1]).toEqual({ name: "totally_unknown" });
  });

  it("READ_ONLY=false exposes exactly 15 tools — the read set plus the five writes", () => {
    const { server, calls } = makeMockServer();
    const ctx: ToolContext = {
      config: makeEnvConfig({ readOnly: false }),
      weeek: dummyWeeek,
    };
    registerAllTools(server, ctx);
    expect(calls()).toEqual([...ALL_TOOLS]);
    // Literal since the I8 seal (#50). The intermediate tickets asserted
    // `READ_TOOLS.length + WRITE_TOOLS.length` because the write set was
    // still growing; that expression could not tell "we shipped the five
    // tools we planned" from "we shipped four and the helper list agrees".
    // The increment is closed, so the number is the contract: 10 + 5.
    expect(calls()).toHaveLength(15);
    expect(WRITE_TOOLS).toHaveLength(5);
  });

  it("no custom-fields tool is exposed, on either side of the gate (#47, ADR 0005 §4)", () => {
    // `weeek_set_task_mr_link` reads `/tm/custom-fields` internally to resolve
    // a field name to its id, and that read is the whole of the server's
    // custom-field surface: the scope lock (#9) declined custom-field CRUD, so
    // there is no listing tool to grow into one. A listing tool added later
    // fails here rather than arriving as a side effect of a resolver refactor.
    for (const readOnly of [true, false]) {
      const { server, calls } = makeMockServer();
      registerAllTools(server, {
        config: makeEnvConfig({ readOnly }),
        weeek: dummyWeeek,
      });
      const customFieldTools = calls().filter(
        (n) => n.includes("custom_field") || n.includes("custom_fields"),
      );
      expect(customFieldTools).toEqual([]);
    }
  });

  it("write tools sit inside the task group, right after weeek_get_task", () => {
    const { server, calls } = makeMockServer();
    registerAllTools(server, {
      config: makeEnvConfig({ readOnly: false }),
      weeek: dummyWeeek,
    });
    const names = calls();
    const firstWrite = names.indexOf(WRITE_TOOLS[0]);
    expect(names[firstWrite - 1]).toBe("weeek_get_task");
  });

  it("the toe-dip combo (READ_ONLY=false + one write name) exposes exactly that tool", () => {
    // The recommended granular rollout from ADR 0004 §1 / the README.
    const { server, calls } = makeMockServer();
    registerAllTools(server, {
      config: makeEnvConfig({
        readOnly: false,
        enabledTools: ["weeek_complete_task"],
      }),
      weeek: dummyWeeek,
    });
    expect(calls()).toEqual(["weeek_complete_task"]);
  });

  it("an allowlist of write tools under the default READ_ONLY=true fails closed-loud", () => {
    // READ_ONLY is the outer gate: naming a write tool does not opt into it.
    // Every entry is skipped, so the zero-tools throw fires before
    // `server.connect()` rather than yielding a silently useless server.
    const { server, calls } = makeMockServer();
    expect(() =>
      registerAllTools(server, {
        config: makeEnvConfig({ enabledTools: [...WRITE_TOOLS] }),
        weeek: dummyWeeek,
      }),
    ).toThrow(/no tools registered/);
    expect(calls()).toHaveLength(0);
  });

  it("logs `tool gated by READ_ONLY` for each hidden write tool", () => {
    const { server } = makeMockServer();
    registerAllTools(server, { config: makeEnvConfig(), weeek: dummyWeeek });
    const gated = infoSpy.mock.calls
      .filter((c) => c[0] === "tool gated by READ_ONLY")
      .map((c) => (c[1] as { name: string }).name);
    expect(gated).toEqual([...WRITE_TOOLS]);
  });

  it("logs `tool gated by ENABLED_TOOLS` for each skipped tool", () => {
    const { server, calls } = makeMockServer();
    const ctx: ToolContext = {
      config: makeEnvConfig({ enabledTools: ["weeek_get_me"] }),
      weeek: dummyWeeek,
    };
    registerAllTools(server, ctx);
    expect(calls()).toEqual(["weeek_get_me"]);
    const gatedInfos = infoSpy.mock.calls.filter(
      (c) => c[0] === "tool gated by ENABLED_TOOLS",
    );
    expect(gatedInfos).toHaveLength(9);
    const gatedNames = gatedInfos.map(
      (c) => (c[1] as { name: string }).name,
    );
    expect(gatedNames).toEqual([
      "ping",
      "weeek_list_projects",
      "weeek_get_project",
      "weeek_list_tasks",
      "weeek_get_task",
      "weeek_list_members",
      "weeek_list_tags",
      "weeek_list_boards",
      "weeek_list_board_columns",
    ]);
  });

  it("Array.includes-based allowlist tolerates duplicate entries silently", () => {
    const { server, calls } = makeMockServer();
    const ctx: ToolContext = {
      config: makeEnvConfig({
        enabledTools: ["ping", "ping"] as readonly string[],
      }),
      weeek: dummyWeeek,
    };
    registerAllTools(server, ctx);
    expect(calls()).toEqual(["ping"]);
    const unknownWarns = warnSpy.mock.calls.filter(
      (c) => c[0] === "unknown tool in ENABLED_TOOLS",
    );
    expect(unknownWarns).toHaveLength(0);
  });
});
