// INVARIANT-1: logger writes ONLY to process.stderr.
// stdout is reserved exclusively for JSON-RPC messages (stdio transport spec).

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function envLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

const currentLevel = envLevel();

// Exact-match (lower-cased) keys whose string values must never reach stderr.
// Match is exact, not substring, so `accessTokenPresent` (a boolean flag)
// does not collide with `accessToken` (the secret).
const REDACT_KEYS = new Set([
  "accesstoken",
  "weeek_access_token",
  "authorization",
  "password",
  "secret",
  "apikey",
  "api_key",
  "token",
]);
const MAX_REDACT_DEPTH = 5;

function redact(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (depth > MAX_REDACT_DEPTH) return "[MaxDepth]";
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (
      REDACT_KEYS.has(k.toLowerCase()) &&
      typeof v === "string" &&
      v.length > 0
    ) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = redact(v, depth + 1, seen);
    }
  }
  return out;
}

function write(
  level: LogLevel,
  msg: string,
  ctx?: Record<string, unknown>,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const payload: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    msg,
  };
  if (ctx) {
    Object.assign(
      payload,
      redact(ctx, 0, new WeakSet()) as Record<string, unknown>,
    );
  }
  try {
    process.stderr.write(JSON.stringify(payload) + "\n");
  } catch {
    // logger must not throw
  }
}

export const logger = {
  debug: (m: string, c?: Record<string, unknown>) => write("debug", m, c),
  info: (m: string, c?: Record<string, unknown>) => write("info", m, c),
  warn: (m: string, c?: Record<string, unknown>) => write("warn", m, c),
  error: (m: string, c?: Record<string, unknown>) => write("error", m, c),
};
