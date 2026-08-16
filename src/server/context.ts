import type { EnvConfig } from "../config/env.js";
import type { WeeekClient } from "../weeek/client.js";

// Threaded into Weeek-aware tool registrations as a closure parameter. We
// deliberately avoid AsyncLocalStorage / DI containers — there is one process,
// one client, one config; closure capture is the smallest thing that works.
export interface ToolContext {
  config: EnvConfig;
  weeek: WeeekClient;
}
