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
      } finally {
        clearTimeout(timer);
      }

      let body: unknown = null;
      const text = await res.text().catch(() => "");
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
    },
  };
}
