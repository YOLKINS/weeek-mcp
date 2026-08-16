import { describe, it, expect } from "vitest";
import { z } from "zod";
import { registerPingTool } from "../../src/tools/ping.tool.js";
import { makeMockMcpServer } from "../helpers/mockMcpServer.js";

describe("registerPingTool", () => {
  it("registers under name 'ping' with all 4 annotation hints set", () => {
    const m = makeMockMcpServer();
    registerPingTool(m.server);
    const reg = m.byName("ping");
    expect(reg).toBeDefined();
    const ann = reg?.config.annotations;
    expect(ann?.["readOnlyHint"]).toBe(true);
    expect(ann?.["destructiveHint"]).toBe(false);
    expect(ann?.["idempotentHint"]).toBe(true);
    expect(ann?.["openWorldHint"]).toBe(false);
  });

  it("structuredContent.reply is 'pong: <msg>'", async () => {
    const m = makeMockMcpServer();
    registerPingTool(m.server);
    const out = (await m.callHandler("ping", { msg: "hi" })) as {
      structuredContent: { reply: string };
    };
    expect(out.structuredContent.reply).toBe("pong: hi");
  });

  it("content[0].text mirrors the structured reply", async () => {
    const m = makeMockMcpServer();
    registerPingTool(m.server);
    const out = (await m.callHandler("ping", { msg: "hi" })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(out.content[0]?.text).toBe("pong: hi");
  });

  it("inputSchema has a zod string under `msg`", () => {
    const m = makeMockMcpServer();
    registerPingTool(m.server);
    const reg = m.byName("ping");
    const inputShape = reg?.config.inputSchema as Record<string, unknown>;
    expect(inputShape["msg"]).toBeInstanceOf(z.ZodString);
  });
});
