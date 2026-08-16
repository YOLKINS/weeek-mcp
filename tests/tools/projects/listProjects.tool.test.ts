import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerWeeekListProjectsTool } from "../../../src/tools/projects/listProjects.tool.js";
import { WeeekError } from "../../../src/weeek/types.js";
import { humanMessage } from "../../../src/weeek/humanMessage.js";
import { logger } from "../../../src/logging/logger.js";
import {
  makeEnvConfig,
  makeEnvelope,
  makeProjectPayload,
} from "../../helpers/factories.js";
import { makeMockMcpServer } from "../../helpers/mockMcpServer.js";
import { makeMockWeeekClient } from "../../helpers/mockWeeekClient.js";
import { WEEEK_PATH } from "../../helpers/paths.js";

describe("registerWeeekListProjectsTool", () => {
  beforeEach(() => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "info").mockImplementation(() => {});
  });

  it("registers with annotations + outputSchema {projects, truncated}", () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    registerWeeekListProjectsTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const reg = srv.byName("weeek_list_projects");
    expect(reg).toBeDefined();
    expect(reg?.config.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    const outputShape = reg?.config.outputSchema as Record<string, unknown>;
    expect(outputShape["projects"]).toBeDefined();
    expect(outputShape["truncated"]).toBeDefined();
  });

  it("happy: '<n> project(s)' + truncated:false", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.whenRequest("GET", WEEEK_PATH.projectsList, {
      status: 200,
      body: makeEnvelope("projects", [
        makeProjectPayload({ id: 1 }),
        makeProjectPayload({ id: 2 }),
        makeProjectPayload({ id: 3 }),
      ]),
    });
    registerWeeekListProjectsTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_projects")) as {
      content: Array<{ type: string; text: string }>;
      structuredContent: { projects: unknown[]; truncated: boolean };
    };
    expect(out.content[0]?.text).toBe("3 project(s)");
    expect(out.structuredContent.projects).toHaveLength(3);
    expect(out.structuredContent.truncated).toBe(false);
  });

  it("WeeekError → isError:true with prefix + humanMessage (INVARIANT-7)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    const err = new WeeekError({
      code: "weeek_server_error",
      message: "weeek http 500",
      status: 500,
    });
    wk.rejectAll(err);
    registerWeeekListProjectsTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_projects")) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(out.isError).toBe(true);
    const text = out.content[0]?.text ?? "";
    expect(text).toMatch(/^weeek_list_projects failed \(weeek_server_error\): /);
    expect(text).toContain(humanMessage(err));
  });

  it("error text never carries project titles or fragments of err.message", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.rejectAll(
      new WeeekError({
        code: "weeek_server_error",
        message: "leak: project=top-secret-launch",
        status: 500,
      }),
    );
    registerWeeekListProjectsTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_projects")) as {
      content: Array<{ type: string; text: string }>;
    };
    const text = out.content[0]?.text ?? "";
    expect(text).not.toContain("top-secret-launch");
    expect(text).toMatch(/^weeek_list_projects failed \(weeek_[a-z_]+\): /);
  });

  it("non-WeeekError rejections propagate untouched", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.rejectAll(new Error("non-weeek failure"));
    registerWeeekListProjectsTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    await expect(srv.callHandler("weeek_list_projects")).rejects.toThrow(
      /non-weeek/,
    );
  });

  it("applyResponseLimits clips on tight budget", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    const many = Array.from({ length: 50 }, (_, i) =>
      makeProjectPayload({
        id: i + 1,
        title: "p".repeat(40),
        color: "#ffffff",
      }),
    );
    wk.whenRequest("GET", WEEEK_PATH.projectsList, {
      status: 200,
      body: makeEnvelope("projects", many),
    });
    registerWeeekListProjectsTool(srv.server, {
      config: makeEnvConfig({ maxResponseChars: 2048 }),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_projects")) as {
      structuredContent: { projects: unknown[]; truncated: boolean };
    };
    expect(out.structuredContent.truncated).toBe(true);
    expect(out.structuredContent.projects.length).toBeLessThan(50);
  });
});
