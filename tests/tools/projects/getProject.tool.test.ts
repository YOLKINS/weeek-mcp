import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerWeeekGetProjectTool } from "../../../src/tools/projects/getProject.tool.js";
import { WeeekError } from "../../../src/weeek/types.js";
import { humanMessage } from "../../../src/weeek/humanMessage.js";
import { logger } from "../../../src/logging/logger.js";
import {
  makeEnvConfig,
  makeEnvelope,
  makeProjectDetailPayload,
} from "../../helpers/factories.js";
import { makeMockMcpServer } from "../../helpers/mockMcpServer.js";
import { makeMockWeeekClient } from "../../helpers/mockWeeekClient.js";
import { WEEEK_PATH } from "../../helpers/paths.js";

describe("registerWeeekGetProjectTool", () => {
  beforeEach(() => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "info").mockImplementation(() => {});
  });

  it("registers with annotations + outputSchema {id,title,description,color,isPrivate,truncated}", () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    registerWeeekGetProjectTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const reg = srv.byName("weeek_get_project");
    expect(reg).toBeDefined();
    expect(reg?.config.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    const outputShape = reg?.config.outputSchema as Record<string, unknown>;
    for (const key of [
      "id",
      "title",
      "description",
      "color",
      "isPrivate",
      "truncated",
    ]) {
      expect(outputShape[key]).toBeDefined();
    }
  });

  it("description style — PRIMARY/DISTINCT/Use when", () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    registerWeeekGetProjectTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const desc = srv.byName("weeek_get_project")?.config.description ?? "";
    expect(desc).toMatch(/PRIMARY tool for/);
    expect(desc).toMatch(/DISTINCT from/);
    expect(desc).toMatch(/Use when/);
  });

  it("happy: '#<id> <title>' + structuredContent + truncated:false", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.whenRequest("GET", WEEEK_PATH.projectById(7), {
      status: 200,
      body: makeEnvelope(
        "project",
        makeProjectDetailPayload({
          id: 7,
          title: "Alpha",
          description: "Q4 launch tracking",
        }),
      ),
    });
    registerWeeekGetProjectTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_get_project", {
      project_id: 7,
    })) as {
      content: Array<{ type: string; text: string }>;
      structuredContent: {
        id: number;
        title: string;
        description: string | null;
        color: string;
        isPrivate: boolean;
        truncated: boolean;
      };
    };
    expect(out.content[0]?.text).toBe("#7 Alpha");
    expect(out.structuredContent).toEqual({
      id: 7,
      title: "Alpha",
      description: "Q4 launch tracking",
      color: "#fff",
      isPrivate: false,
      truncated: false,
    });
  });

  it("WeeekError → isError:true with prefix + humanMessage (INVARIANT-7)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    const err = new WeeekError({
      code: "weeek_not_found",
      message: "weeek http 404",
      status: 404,
    });
    wk.rejectAll(err);
    registerWeeekGetProjectTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_get_project", {
      project_id: 999,
    })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(out.isError).toBe(true);
    const text = out.content[0]?.text ?? "";
    expect(text).toMatch(/^weeek_get_project failed \(weeek_not_found\): /);
    expect(text).toContain(humanMessage(err));
  });

  it("error text never carries err.message body fragments", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.rejectAll(
      new WeeekError({
        code: "weeek_server_error",
        message: "leak: project=top-secret-launch",
        status: 500,
      }),
    );
    registerWeeekGetProjectTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_get_project", {
      project_id: 1,
    })) as {
      content: Array<{ type: string; text: string }>;
    };
    const text = out.content[0]?.text ?? "";
    expect(text).not.toContain("top-secret-launch");
    expect(text).toMatch(/^weeek_get_project failed \(weeek_[a-z_]+\): /);
  });

  it("non-WeeekError rejections propagate untouched", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.rejectAll(new Error("non-weeek failure"));
    registerWeeekGetProjectTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    await expect(
      srv.callHandler("weeek_get_project", { project_id: 1 }),
    ).rejects.toThrow(/non-weeek/);
  });

  it("applyResponseLimits clips long description on tight budget", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.whenRequest("GET", WEEEK_PATH.projectById(1), {
      status: 200,
      body: makeEnvelope(
        "project",
        makeProjectDetailPayload({
          id: 1,
          title: "Alpha",
          description: "x".repeat(8000),
        }),
      ),
    });
    registerWeeekGetProjectTool(srv.server, {
      config: makeEnvConfig({ maxResponseChars: 1024 }),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_get_project", {
      project_id: 1,
    })) as {
      structuredContent: {
        description: string | null;
        truncated: boolean;
      };
    };
    expect(out.structuredContent.truncated).toBe(true);
    expect(out.structuredContent.description ?? "").toContain(
      "…[truncated]",
    );
    expect((out.structuredContent.description ?? "").length).toBeLessThan(
      8000,
    );
  });
});
