import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerWeeekListTagsTool } from "../../../src/tools/tags/listTags.tool.js";
import { WeeekError } from "../../../src/weeek/types.js";
import { humanMessage } from "../../../src/weeek/humanMessage.js";
import { logger } from "../../../src/logging/logger.js";
import {
  makeEnvConfig,
  makeEnvelope,
  makeTagPayload,
} from "../../helpers/factories.js";
import { makeMockMcpServer } from "../../helpers/mockMcpServer.js";
import { makeMockWeeekClient } from "../../helpers/mockWeeekClient.js";
import { WEEEK_PATH } from "../../helpers/paths.js";

describe("registerWeeekListTagsTool", () => {
  beforeEach(() => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "info").mockImplementation(() => {});
  });

  it("registers with annotations + outputSchema {tags, truncated}", () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    registerWeeekListTagsTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const reg = srv.byName("weeek_list_tags");
    expect(reg).toBeDefined();
    expect(reg?.config.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    const outputShape = reg?.config.outputSchema as Record<string, unknown>;
    expect(outputShape["tags"]).toBeDefined();
    expect(outputShape["truncated"]).toBeDefined();
  });

  it("happy: '<n> tag(s)' + truncated:false", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.whenRequest("GET", WEEEK_PATH.tagsList, {
      status: 200,
      body: makeEnvelope("tags", [
        makeTagPayload({ id: 1 }),
        makeTagPayload({ id: 2 }),
      ]),
    });
    registerWeeekListTagsTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_tags")) as {
      content: Array<{ type: string; text: string }>;
      structuredContent: { tags: unknown[]; truncated: boolean };
    };
    expect(out.content[0]?.text).toBe("2 tag(s)");
    expect(out.structuredContent.tags).toHaveLength(2);
    expect(out.structuredContent.truncated).toBe(false);
  });

  it("WeeekError → isError:true with prefix + humanMessage (INVARIANT-7)", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    const err = new WeeekError({
      code: "weeek_unauthorized",
      message: "weeek http 401",
      status: 401,
    });
    wk.rejectAll(err);
    registerWeeekListTagsTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_tags")) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(out.isError).toBe(true);
    const text = out.content[0]?.text ?? "";
    expect(text).toMatch(/^weeek_list_tags failed \(weeek_unauthorized\): /);
    expect(text).toContain(humanMessage(err));
  });

  it("error text never carries the err.message body", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.rejectAll(
      new WeeekError({
        code: "weeek_unauthorized",
        message: "leak: tag=internal-codename",
        status: 401,
      }),
    );
    registerWeeekListTagsTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_tags")) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(out.content[0]?.text).not.toContain("internal-codename");
    expect(out.content[0]?.text).toMatch(
      /^weeek_list_tags failed \(weeek_[a-z_]+\): /,
    );
  });

  it("non-WeeekError rejections propagate untouched", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    wk.rejectAll(new Error("non-weeek failure"));
    registerWeeekListTagsTool(srv.server, {
      config: makeEnvConfig(),
      weeek: wk.client,
    });
    await expect(srv.callHandler("weeek_list_tags")).rejects.toThrow(
      /non-weeek/,
    );
  });

  it("applyResponseLimits clips tags on tight budget", async () => {
    const srv = makeMockMcpServer();
    const wk = makeMockWeeekClient();
    const many = Array.from({ length: 100 }, (_, i) =>
      makeTagPayload({
        id: i + 1,
        title: "t".repeat(40),
        color: "#ffffff",
      }),
    );
    wk.whenRequest("GET", WEEEK_PATH.tagsList, {
      status: 200,
      body: makeEnvelope("tags", many),
    });
    registerWeeekListTagsTool(srv.server, {
      config: makeEnvConfig({ maxResponseChars: 2048 }),
      weeek: wk.client,
    });
    const out = (await srv.callHandler("weeek_list_tags")) as {
      structuredContent: { tags: unknown[]; truncated: boolean };
    };
    expect(out.structuredContent.truncated).toBe(true);
    expect(out.structuredContent.tags.length).toBeLessThan(100);
  });
});
