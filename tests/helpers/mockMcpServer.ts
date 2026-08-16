import { vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Mirrors the surface of `McpServer.registerTool(name, config, handler)` we
// rely on. The SDK passes `(args, extra)` to handlers; we forward only
// `args` because nothing in our handlers reads `extra`.
export interface CapturedRegistration {
  name: string;
  config: {
    title?: string;
    description?: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
    annotations?: Record<string, unknown>;
  };
  handler: (args: Record<string, unknown>) => unknown;
}

export interface MockMcpServer {
  server: McpServer;
  registrations: () => CapturedRegistration[];
  byName: (name: string) => CapturedRegistration | undefined;
  callHandler: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<unknown>;
}

export function makeMockMcpServer(): MockMcpServer {
  const registrations: CapturedRegistration[] = [];

  // NOTE (RETRO-21): handlers are invoked here without zod input-validation.
  // The SDK's input-validation path is exercised by `docs/smoke.md` recipes
  // — tool tests do NOT regression-cover input-shape rejection.
  const registerTool = vi.fn(
    (
      name: string,
      config: CapturedRegistration["config"],
      handler: CapturedRegistration["handler"],
    ) => {
      registrations.push({ name, config, handler });
    },
  );

  const server = { registerTool } as unknown as McpServer;

  const byName = (name: string): CapturedRegistration | undefined =>
    registrations.find((r) => r.name === name);

  return {
    server,
    registrations: () => registrations.slice(),
    byName,
    callHandler(name, args = {}) {
      const reg = byName(name);
      if (!reg) {
        return Promise.reject(
          new Error(`MockMcpServer: tool '${name}' not registered`),
        );
      }
      return Promise.resolve(reg.handler(args));
    },
  };
}
