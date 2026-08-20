import type { EnvConfig } from "../config/env.js";
import { WeeekError } from "./types.js";
import { redactUrl } from "./unwrap.js";

// I8 (#42): the surface widens from `GET`-only to the four methods the Weeek
// write endpoints use. No `DELETE` — task deletion is deliberately out of
// scope (ADR 0004), so the type cannot express it.
export type WeeekWriteMethod = "POST" | "PUT" | "PATCH";
export type WeeekMethod = "GET" | WeeekWriteMethod;

// A union, not one shape with an optional `body`: a body only means something
// on a write, so `{ method: "GET", body: … }` is a compile error rather than
// a silently dropped payload.
export type WeeekRequest =
  | {
      method: "GET";
      // Path relative to `config.baseUrl`; leading slash optional.
      path: string;
    }
  | {
      method: WeeekWriteMethod;
      path: string;
      // JSON request body. Serialized with `JSON.stringify` at the call site
      // below and sent with `Content-Type: application/json`.
      //
      // INVARIANT-2 (body side): the body is tenant data (task titles,
      // descriptions, assignee ids). It is NEVER logged — not on the happy
      // path, not on an error path, and never copied into a `WeeekError`
      // message or cause. Pinned by `tests/weeek/client.test.ts` ("request
      // body never reaches the logs"), which spies `process.stderr.write`
      // directly rather than relying on the logger's redaction as the only
      // line of defence.
      body?: unknown;
    };

export interface WeeekRawResponse {
  status: number;
  body: unknown;
}

export interface WeeekClient {
  request(req: WeeekRequest): Promise<WeeekRawResponse>;
}

function joinUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

// INVARIANT-2: the `Authorization` header is built per-request and never
// passed to the logger. Any header object we *do* log is funnelled through
// `src/logging/logger.ts`, which redacts the `authorization` key recursively.
export function createWeeekClient(config: EnvConfig): WeeekClient {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.accessToken}`,
    Accept: "application/json",
  };
  // Built once, never by mutating `headers` — a `GET` must stay byte-identical
  // to the pre-I8 read path (two headers, no body), so the write variant is a
  // separate frozen-by-convention object rather than a per-request rebuild.
  const writeHeaders: Record<string, string> = {
    ...headers,
    "Content-Type": "application/json",
  };

  return {
    async request(req) {
      const url = joinUrl(config.baseUrl, req.path);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      const init: RequestInit =
        req.method === "GET"
          ? { method: "GET", headers, signal: controller.signal }
          : {
              method: req.method,
              headers: writeHeaders,
              ...(req.body !== undefined
                ? { body: JSON.stringify(req.body) }
                : {}),
              signal: controller.signal,
            };
      // 1.0.1: the timer is cleared in ONE outer `finally` that spans
      // both the header phase and the body phase, so `WEEEK_TIMEOUT_MS` is a
      // deadline for the whole request rather than for `fetch` alone. Before
      // this, `clearTimeout` ran the moment headers arrived, and a server that
      // sent a status line and then stalled was bounded only by undici's own
      // ~300 s `bodyTimeout` — measured at 6 020 ms of hang under
      // `WEEEK_TIMEOUT_MS=500` with `signal.aborted === false`.
      try {
        let res: Response;
        try {
          res = await fetch(url, init);
        } catch (err) {
          const isAbort =
            err instanceof DOMException && err.name === "AbortError";
          throw new WeeekError({
            code: isAbort ? "weeek_timeout" : "weeek_network",
            message: isAbort
              ? `weeek request timed out after ${String(config.timeoutMs)}ms`
              : `weeek network error for ${redactUrl(url)}`,
            cause: err,
          });
        }

        let text: string;
        try {
          text = await res.text();
        } catch (err) {
          // Body-phase classification, in the order the three outcomes differ.
          //
          // (a) Our own deadline fired mid-read. Discriminated on
          // `controller.signal.aborted`, NOT on `instanceof DOMException` as
          // the header phase above does. Both hold on Node 24.5.0 (measured:
          // `DOMException` / `name: "AbortError"` / `signal.aborted === true`),
          // so this is belt-and-braces — but it is the one classification in
          // this file that would otherwise depend on which shape a given
          // undici version throws from a body read. The header-phase predicate
          // deliberately stays as it is: RETRO-14 pins it.
          if (controller.signal.aborted) {
            throw new WeeekError({
              code: "weeek_timeout",
              message: `weeek request timed out after ${String(config.timeoutMs)}ms`,
              cause: err,
            });
          }
          // (b) The socket died under a 2xx. Measured: `TypeError: terminated`
          // with a `SocketError` cause and `signal.aborted === false`. This
          // used to collapse into `text = ""` → `body = null` →
          // `weeek_invalid_response`, whose sentence tells the agent "the
          // upstream API contract may have drifted — file an issue". That
          // blamed Weeek for our own severed connection. It is a network fault
          // and says so.
          if (res.status >= 200 && res.status < 300) {
            throw new WeeekError({
              code: "weeek_network",
              message: `weeek network error for ${redactUrl(url)}`,
              cause: err,
            });
          }
          // (c) The body failed under a non-2xx. Here the empty-string
          // fallback is the RIGHT answer and is kept: the status alone already
          // classifies the failure correctly via `unwrap.codeForStatus` (a
          // truncated 502 is `weeek_server_error`, which is what happened),
          // and an unconditional `weeek_network` would destroy that. Pinned by
          // RETRO-15 below in `tests/weeek/client.test.ts`.
          text = "";
        }

        let body: unknown = null;
        if (text.length > 0) {
          try {
            body = JSON.parse(text);
          } catch {
            throw new WeeekError({
              code: "weeek_invalid_response",
              message: "weeek response was not valid JSON",
              status: res.status,
            });
          }
        }
        return { status: res.status, body };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
