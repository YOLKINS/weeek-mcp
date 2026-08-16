import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerWeeekListMembersTool } from "../../../src/tools/users/listMembers.tool.js";
import { WeeekError } from "../../../src/weeek/types.js";
import { humanMessage } from "../../../src/weeek/humanMessage.js";
import { logger } from "../../../src/logging/logger.js";
import {
  makeEnvConfig,
  makeEnvelope,
  makeMemberPayload,
} from "../../helpers/factories.js";
import { makeMockMcpServer } from "../../helpers/mockMcpServer.js";
import { makeMockWeeekClient } from "../../helpers/mockWeeekClient.js";
import { WEEEK_PATH } from "../../helpers/paths.js";

describe("registerWeeekListMembersTool", () => {
  beforeEach(() => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "info").mockImplementation(() => {});
  });

  it("registers under 'weeek_list_members' with annotations + outputSchema (members + truncated)", () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    registerWeeekListMembersTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const reg = srv.byName("weeek_list_members");
    expect(reg).toBeDefined();
    expect(reg?.config.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    const outputShape = reg?.config.outputSchema as Record<string, unknown>;
    expect(outputShape["members"]).toBeDefined();
    expect(outputShape["truncated"]).toBeDefined();
  });

  it("happy: text '<n> member(s)', members carried through, truncated:false", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.whenRequest("GET", WEEEK_PATH.membersList, {
      status: 200,
      body: makeEnvelope("members", [
        makeMemberPayload({ id: "u-1" }),
        makeMemberPayload({ id: "u-2", email: "x@y.z" }),
      ]),
    });
    registerWeeekListMembersTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_members")) as {
      content: Array<{ type: string; text: string }>;
      structuredContent: { members: unknown[]; truncated: boolean };
    };
    expect(out.content[0]?.text).toBe("2 member(s)");
    expect(out.structuredContent.members).toHaveLength(2);
    expect(out.structuredContent.truncated).toBe(false);
  });

  it("WeeekError → isError:true with prefix + humanMessage (INVARIANT-7)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    const err = new WeeekError({
      code: "weeek_forbidden",
      message: "weeek http 403",
      status: 403,
    });
    wk.rejectAll(err);
    registerWeeekListMembersTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_members")) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(out.isError).toBe(true);
    const text = out.content[0]?.text ?? "";
    expect(text).toMatch(/^weeek_list_members failed \(weeek_forbidden\): /);
    expect(text).toContain(humanMessage(err));
  });

  it("error text never contains member email/firstName values (INVARIANT-9)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.rejectAll(
      new WeeekError({
        code: "weeek_forbidden",
        message: "leak: secret-mem@example.com firstName=secretFirst",
        status: 403,
      }),
    );
    registerWeeekListMembersTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_members")) as {
      content: Array<{ type: string; text: string }>;
    };
    const text = out.content[0]?.text ?? "";
    expect(text).not.toContain("secret-mem");
    expect(text).not.toContain("secretFirst");
    expect(text).toMatch(/^weeek_list_members failed \(weeek_forbidden\): /);
  });

  it("non-WeeekError rejections propagate untouched (only Weeek errors map to isError)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.rejectAll(new Error("non-weeek failure"));
    registerWeeekListMembersTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    await expect(srv.callHandler("weeek_list_members")).rejects.toThrow(
      /non-weeek/,
    );
  });

  it("applyResponseLimits clips members on a tight budget (truncated:true)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    const many = Array.from({ length: 100 }, (_, i) =>
      makeMemberPayload({
        id: `u-${String(i)}`,
        email: `m${String(i)}@example.com`,
        firstName: "fn-".repeat(8),
        lastName: "ln-".repeat(8),
      }),
    );
    wk.whenRequest("GET", WEEEK_PATH.membersList, {
      status: 200,
      body: makeEnvelope("members", many),
    });
    registerWeeekListMembersTool(srv.server, {
      config: makeEnvConfig({ maxResponseChars: 2048 }),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_members")) as {
      structuredContent: { members: unknown[]; truncated: boolean };
    };
    expect(out.structuredContent.truncated).toBe(true);
    expect(out.structuredContent.members.length).toBeLessThan(100);
  });
});
