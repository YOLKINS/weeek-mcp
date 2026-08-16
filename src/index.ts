#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config/env.js";
import { logger } from "./logging/logger.js";
import { registerAllTools } from "./tools/registry.js";
import { createWeeekClient } from "./weeek/client.js";

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info("config loaded", {
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    readOnly: config.readOnly,
    enabledTools: config.enabledTools ?? null,
    maxResponseChars: config.maxResponseChars,
  });

  const weeek = createWeeekClient(config);

  const server = new McpServer(
    { name: "weeek-mcp", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Read-only MCP server for Weeek. Available tools: `ping` (health), " +
        "`weeek_get_me` (current account), `weeek_list_projects`, " +
        "`weeek_get_project`, " +
        "`weeek_list_tasks` (paginated via offset/per_page + hasMore), " +
        "`weeek_get_task`, `weeek_list_members`, `weeek_list_tags`, " +
        "`weeek_list_boards`, `weeek_list_board_columns`. " +
        "Every tool input is snake_case (`project_id`, `task_id`, " +
        "`board_id`, `per_page`) — camelCase arguments are rejected. " +
        "Server-side gates: READ_ONLY (default on) hides any tool whose " +
        "annotations.readOnlyHint !== true; ENABLED_TOOLS (optional, " +
        "comma-separated) restricts registration to listed names; " +
        "MAX_RESPONSE_CHARS limits structuredContent size — list tools may " +
        "return fewer items with truncated:true; weeek_get_task / " +
        "weeek_get_project may clip description with the trailing marker. " +
        "All three gates compose. Mutating tools land in I8+.",
    },
  );

  registerAllTools(server, { config, weeek });

  const transport = new StdioServerTransport();

  const shutdown = (signal: NodeJS.Signals) => {
    logger.info("shutting down", { signal });
    server
      .close()
      .catch((err) =>
        logger.error("server close error during shutdown", {
          err: err instanceof Error ? err.message : String(err),
        }),
      )
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(transport);
  logger.info("mcp server started", {
    name: "weeek-mcp",
    targetedProtocolVersion: "2025-06-18",
  });
}

main().catch((err) => {
  logger.error("fatal: main() rejected", {
    err: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
