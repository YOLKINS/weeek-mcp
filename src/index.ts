#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config/env.js";
import { logger } from "./logging/logger.js";
import { buildInstructions } from "./server/instructions.js";
import { registerAllTools, selectTools } from "./tools/registry.js";
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

  // The gate runs HERE, once, before the constructor — `instructions` is a
  // constructor option, so the selected surface has to be known first. The
  // same selection is handed to `registerAllTools` below rather than
  // recomputed, which is what keeps the gate's log lines to one emission each
  // (1.0.1).
  const selected = selectTools(config);

  const server = new McpServer(
    { name: "weeek-mcp", version: "1.0.1" },
    {
      capabilities: { tools: {} },
      instructions: buildInstructions(selected),
    },
  );

  registerAllTools(server, { config, weeek }, selected);

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
