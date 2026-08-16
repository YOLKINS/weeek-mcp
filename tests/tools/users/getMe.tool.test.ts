import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerWeeekGetMeTool } from "../../../src/tools/users/getMe.tool.js";
import { WeeekError } from "../../../src/weeek/types.js";
import { humanMessage } from "../../../src/weeek/humanMessage.js";
import { logger } from "../../../src/logging/logger.js";
import {
  makeEnvConfig,
  makeEnvelope,
  makeUserPayload,
} from "../../helpers/factories.js";
import { makeMockMcpServer } from "../../helpers/mockMcpServer.js";
import { makeMockWeeekClient } from "../../helpers/mockWeeekClient.js";
import { WEEEK_PATH } from "../../helpers/paths.js";

describe("registerWeeekGetMeTool", () => {
  beforeEach(() => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "info").mockImplementation(() => {});
  });

  it("registers under name 'weeek_get_me' with annotations + outputSchema", () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    registerWeeekGetMeTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const reg = srv.byName("weeek_get_me");
    expect(reg).toBeDefined();
    const ann = reg?.config.annotations;
    expect(ann).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(reg?.config.outputSchema).toBeDefined();
  });

  it("happy path emits text 'Anna Pak <email>' + structuredContent {id,email,name}", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.whenRequest("GET", WEEEK_PATH.userMe, {
      status: 200,
      body: makeEnvelope(
        "user",
        makeUserPayload({ id: 7, email: "anna@example.com" }),
      ),
    });
    registerWeeekGetMeTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_get_me")) as {
      content: Array<{ type: string; text: string }>;
      structuredContent: Record<string, unknown>;
    };
    expect(out.content[0]?.text).toBe("Anna Pak <anna@example.com>");
    expect(out.structuredContent).toEqual({
      id: 7,
      email: "anna@example.com",
      name: "Anna Pak",
    });
  });

  it("WeeekError(weeek_unauthorized) → isError:true with prefix + humanMessage (INVARIANT-7)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    const err = new WeeekError({
      code: "weeek_unauthorized",
      message: "weeek http 401",
      status: 401,
    });
    wk.rejectAll(err);
    registerWeeekGetMeTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_get_me")) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(out.isError).toBe(true);
    const text = out.content[0]?.text ?? "";
    expect(text).toMatch(/^weeek_get_me failed \(weeek_unauthorized\): /);
    expect(text).toContain(humanMessage(err));
  });

  it("error text contains no email/firstName/lastName/id from the response (INVARIANT-9)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    // Payload would derive name "Anna Pak <anna@example.com>" if leaked.
    wk.rejectAll(
      new WeeekError({
        code: "weeek_unauthorized",
        message:
          "internal: would-leak anna@example.com firstName=Anna lastName=Pak id=7",
        status: 401,
      }),
    );
    registerWeeekGetMeTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_get_me")) as {
      content: Array<{ type: string; text: string }>;
    };
    const text = out.content[0]?.text ?? "";
    expect(text).not.toMatch(/anna@example\.com/);
    expect(text).not.toMatch(/firstName/);
    expect(text).not.toMatch(/lastName/);
    expect(text).toMatch(/^weeek_get_me failed \(weeek_[a-z_]+\): /);
  });

  it("non-WeeekError rejections propagate untouched (only Weeek errors map to isError)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.rejectAll(new Error("some random failure"));
    registerWeeekGetMeTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    await expect(srv.callHandler("weeek_get_me")).rejects.toThrow(
      /some random/,
    );
  });
});
