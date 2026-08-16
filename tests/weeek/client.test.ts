import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
  type MockInstance,
} from "vitest";
import {
  createWeeekClient,
  type WeeekRequest,
} from "../../src/weeek/client.js";
import { WeeekError } from "../../src/weeek/types.js";
import { logger } from "../../src/logging/logger.js";
import { makeEnvConfig } from "../helpers/factories.js";
import { WEEEK_PATH } from "../helpers/paths.js";

interface MockResponseInit {
  status?: number;
  body?: string;
}

function mockResponse(init: MockResponseInit = {}): Response {
  const status = init.status ?? 200;
  const body = init.body ?? "";
  return {
    status,
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("createWeeekClient", () => {
  let fetchSpy: Mock<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns {status, body} with parsed JSON envelope on 2xx", async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({
        status: 200,
        body: JSON.stringify({ success: true, user: { id: 1 } }),
      }),
    );
    const client = createWeeekClient(makeEnvConfig());
    const out = await client.request({ method: "GET", path: WEEEK_PATH.userMe });
    expect(out).toEqual({
      status: 200,
      body: { success: true, user: { id: 1 } },
    });
  });

  it("returns body=null when the response body is empty", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ status: 200, body: "" }));
    const client = createWeeekClient(makeEnvConfig());
    const out = await client.request({ method: "GET", path: "/x" });
    expect(out.body).toBeNull();
    expect(out.status).toBe(200);
  });

  it("throws WeeekError(weeek_invalid_response) when body is not JSON", async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({ status: 200, body: "<html>oops</html>" }),
    );
    const client = createWeeekClient(makeEnvConfig());
    let err: unknown;
    try {
      await client.request({ method: "GET", path: "/x" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WeeekError);
    const we = err as WeeekError;
    expect(we.code).toBe("weeek_invalid_response");
    expect(we.status).toBe(200);
  });

  it("non-2xx with valid JSON is forwarded as-is (caller maps via parseWeeekResponse)", async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({
        status: 401,
        body: JSON.stringify({ message: "no" }),
      }),
    );
    const client = createWeeekClient(makeEnvConfig());
    const out = await client.request({ method: "GET", path: "/x" });
    expect(out.status).toBe(401);
    expect(out.body).toEqual({ message: "no" });
  });

  it("AbortError → WeeekError(weeek_timeout)", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.reject(new DOMException("aborted", "AbortError")),
    );
    const client = createWeeekClient(makeEnvConfig({ timeoutMs: 100 }));
    let err: unknown;
    try {
      await client.request({ method: "GET", path: "/x" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WeeekError);
    const we = err as WeeekError;
    expect(we.code).toBe("weeek_timeout");
    expect(we.message).toContain("100");
  });

  // The test above — and every other timeout case in this file — *simulates*
  // the abort by rejecting `fetch` outright. None of them exercises the thing
  // that would actually abort a hanging request in production: the client's
  // own `setTimeout(() => controller.abort(), timeoutMs)`. Vitest 4's
  // AST-aware coverage is what surfaced the gap (#56) — the v3 provider had
  // been scoring that callback as covered because the line declaring it ran.
  // Here `fetch` never settles on its own, so the timer is the only thing
  // that can end the request.
  it("the client's own timer aborts a fetch that never settles", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    fetchSpy.mockImplementation((_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    const client = createWeeekClient(makeEnvConfig({ timeoutMs: 100 }));
    const settled = client
      .request({ method: "GET", path: "/x" })
      .catch((e: unknown) => e);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(signal?.aborted).toBe(true);
    const err = await settled;
    expect(err).toBeInstanceOf(WeeekError);
    expect((err as WeeekError).code).toBe("weeek_timeout");
  });

  it("non-Abort fetch error → WeeekError(weeek_network)", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.reject(new TypeError("network down")),
    );
    const client = createWeeekClient(makeEnvConfig());
    let err: unknown;
    try {
      await client.request({ method: "GET", path: "/x" });
    } catch (e) {
      err = e;
    }
    const we = err as WeeekError;
    expect(we).toBeInstanceOf(WeeekError);
    expect(we.code).toBe("weeek_network");
  });

  // RETRO-14: pin the `instanceof DOMException` discriminator at
  // src/weeek/client.ts:48-49. A plain Error whose `name` happens to be
  // "AbortError" must NOT be classified as a timeout.
  it("non-DOMException AbortError-named Error → weeek_network (not weeek_timeout)", async () => {
    const fakeAbort = new Error("aborted");
    fakeAbort.name = "AbortError";
    fetchSpy.mockImplementation(() => Promise.reject(fakeAbort));
    const client = createWeeekClient(makeEnvConfig({ timeoutMs: 100 }));
    let err: unknown;
    try {
      await client.request({ method: "GET", path: "/x" });
    } catch (e) {
      err = e;
    }
    const we = err as WeeekError;
    expect(we).toBeInstanceOf(WeeekError);
    expect(we.code).toBe("weeek_network");
  });

  // RETRO-15: pin the `await res.text().catch(() => "")` silent fallback at
  // src/weeek/client.ts:62. A rejecting Response.text() must yield body=null
  // and forward the status.
  it("Response.text() rejection → body=null, status forwarded", async () => {
    fetchSpy.mockResolvedValue({
      status: 502,
      text: () => Promise.reject(new TypeError("decode failed")),
    } as unknown as Response);
    const client = createWeeekClient(makeEnvConfig());
    const out = await client.request({ method: "GET", path: "/x" });
    expect(out.status).toBe(502);
    expect(out.body).toBeNull();
  });

  it("weeek_network message redacts URL credentials", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.reject(new TypeError("network")),
    );
    const client = createWeeekClient(
      makeEnvConfig({ baseUrl: "https://u:p@host.example.com/v1" }),
    );
    let err: unknown;
    try {
      await client.request({ method: "GET", path: "/x" });
    } catch (e) {
      err = e;
    }
    const we = err as WeeekError;
    expect(we.message).toContain("https://host.example.com/v1");
    expect(we.message).not.toContain("u:p@");
  });

  it("clearTimeout fires even when fetch rejects", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.reject(new TypeError("boom")),
    );
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const client = createWeeekClient(makeEnvConfig());
    await expect(
      client.request({ method: "GET", path: "/x" }),
    ).rejects.toBeInstanceOf(WeeekError);
    expect(clearSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it.each<[string, string, string]>([
    ["https://api.example.com/v1", "/x", "https://api.example.com/v1/x"],
    ["https://api.example.com/v1/", "/x", "https://api.example.com/v1/x"],
    ["https://api.example.com/v1", "x", "https://api.example.com/v1/x"],
    ["https://api.example.com/v1/", "x", "https://api.example.com/v1/x"],
  ])(
    "joinUrl: base=%s + path=%s → %s (single slash, no double)",
    async (base, path, expected) => {
      fetchSpy.mockResolvedValue(mockResponse({ status: 200, body: "" }));
      const client = createWeeekClient(makeEnvConfig({ baseUrl: base }));
      await client.request({ method: "GET", path });
      const url = fetchSpy.mock.calls[0]?.[0] as string;
      expect(url).toBe(expected);
    },
  );

  it("Authorization header is built once per createWeeekClient (closure reuse across requests)", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ status: 200, body: "" }));
    const client = createWeeekClient(makeEnvConfig());
    await client.request({ method: "GET", path: "/a" });
    await client.request({ method: "GET", path: "/b" });
    const init1 = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const init2 = fetchSpy.mock.calls[1]?.[1] as RequestInit;
    // Same headers reference: we don't rebuild per request.
    expect(init1.headers).toBe(init2.headers);
  });

  it("Authorization header has shape `Bearer <token>` matching config", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ status: 200, body: "" }));
    const config = makeEnvConfig({ accessToken: "tok-abcdefghijklmnopqr" });
    const client = createWeeekClient(config);
    await client.request({ method: "GET", path: "/x" });
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${config.accessToken}`);
  });

  it("Accept header is application/json", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ status: 200, body: "" }));
    const client = createWeeekClient(makeEnvConfig());
    await client.request({ method: "GET", path: "/x" });
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/json");
  });

  it("WeeekError.cause is set when fetch throws", async () => {
    const cause = new Error("inner");
    fetchSpy.mockImplementation(() => Promise.reject(cause));
    const client = createWeeekClient(makeEnvConfig());
    let err: unknown;
    try {
      await client.request({ method: "GET", path: "/x" });
    } catch (e) {
      err = e;
    }
    const we = err as WeeekError;
    expect(we.cause).toBe(cause);
  });

  it("never passes Authorization to logger (INVARIANT-2b regression)", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

    fetchSpy.mockResolvedValueOnce(mockResponse({ status: 200, body: "" }));
    const client = createWeeekClient(makeEnvConfig());
    await client.request({ method: "GET", path: "/ok" });

    fetchSpy.mockImplementationOnce(() => Promise.reject(new TypeError("x")));
    await client
      .request({ method: "GET", path: "/err" })
      .catch(() => undefined);

    // I8 (#42), gate E: the write path carries a second headers object, so
    // the token guard drives it too — happy path and error path.
    fetchSpy.mockResolvedValueOnce(mockResponse({ status: 200, body: "" }));
    await client.request({ method: "POST", path: "/ok", body: { a: 1 } });

    fetchSpy.mockImplementationOnce(() => Promise.reject(new TypeError("x")));
    await client
      .request({ method: "PUT", path: "/err", body: { a: 1 } })
      .catch(() => undefined);

    const allCalls = [
      ...warnSpy.mock.calls,
      ...infoSpy.mock.calls,
      ...errorSpy.mock.calls,
    ];
    for (const call of allCalls) {
      const ctx = call[1];
      if (ctx === undefined || ctx === null) continue;
      const text = JSON.stringify(ctx);
      expect(text.toLowerCase()).not.toContain("authorization");
      expect(text.toLowerCase()).not.toContain("bearer ");
    }
  });

  it("concurrent requests share the headers object identity (no per-request mutation)", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ status: 200, body: "" }));
    const client = createWeeekClient(makeEnvConfig());
    await Promise.all([
      client.request({ method: "GET", path: "/a" }),
      client.request({ method: "GET", path: "/b" }),
    ]);
    const init1 = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const init2 = fetchSpy.mock.calls[1]?.[1] as RequestInit;
    expect(init1.headers).toBe(init2.headers);
    const headers = init1.headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual(["Accept", "Authorization"]);
  });
});

// I8 (#42) — the client learns to write. Two contracts are pinned here:
// (a) non-`GET` carries `Content-Type: application/json` + the serialized
// body, while `GET` stays byte-identical to the read path (no body, no
// content-type header); (b) the request body NEVER reaches a log line, on
// any path (INVARIANT-2, body-side).
describe("createWeeekClient — write methods", () => {
  let fetchSpy: Mock<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const WRITE_METHODS = ["POST", "PUT", "PATCH"] as const;

  it.each(WRITE_METHODS)(
    "%s sends Content-Type: application/json and the JSON.stringify-ed body",
    async (method) => {
      fetchSpy.mockResolvedValue(
        mockResponse({
          status: 200,
          body: JSON.stringify({ success: true, task: { id: 7 } }),
        }),
      );
      const client = createWeeekClient(makeEnvConfig());
      const out = await client.request({
        method,
        path: "/tm/tasks",
        body: { title: "t", projectId: 1 },
      });

      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      expect(init.method).toBe(method);
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["Accept"]).toBe("application/json");
      expect(init.body).toBe(JSON.stringify({ title: "t", projectId: 1 }));
      expect(out).toEqual({
        status: 200,
        body: { success: true, task: { id: 7 } },
      });
    },
  );

  it("a body on GET is a compile error, not a silently dropped payload", () => {
    // If the union ever collapses back into one shape with an optional
    // `body`, this `@ts-expect-error` becomes unused and
    // `npm run typecheck:tests` fails — which is the point.
    // @ts-expect-error — `body` only means something on a write method.
    const bad: WeeekRequest = { method: "GET", path: "/x", body: { a: 1 } };
    expect(bad.method).toBe("GET");
  });

  it("GET is unchanged: no body, no Content-Type header", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ status: 200, body: "" }));
    const client = createWeeekClient(makeEnvConfig());
    await client.request({ method: "GET", path: "/tm/tasks" });
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual(["Accept", "Authorization"]);
    expect(init.body).toBeUndefined();
  });

  it("a write with no body still carries Content-Type but sends no body", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ status: 200, body: "" }));
    const client = createWeeekClient(makeEnvConfig());
    await client.request({ method: "PUT", path: "/tm/tasks/1" });
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBeUndefined();
  });

  it("a write does not mutate the shared read headers (GET stays two-keyed after a POST)", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ status: 200, body: "" }));
    const client = createWeeekClient(makeEnvConfig());
    await client.request({ method: "POST", path: "/tm/tasks", body: { a: 1 } });
    await client.request({ method: "GET", path: "/tm/tasks" });
    const writeHeaders = (fetchSpy.mock.calls[0]?.[1] as RequestInit)
      .headers as Record<string, string>;
    const readHeaders = (fetchSpy.mock.calls[1]?.[1] as RequestInit)
      .headers as Record<string, string>;
    expect(Object.keys(readHeaders).sort()).toEqual(["Accept", "Authorization"]);
    expect(Object.keys(writeHeaders).sort()).toEqual([
      "Accept",
      "Authorization",
      "Content-Type",
    ]);
    expect(readHeaders).not.toBe(writeHeaders);
  });

  it("write headers keep object identity across requests (no per-request rebuild)", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ status: 200, body: "" }));
    const client = createWeeekClient(makeEnvConfig());
    await client.request({ method: "POST", path: "/a", body: { a: 1 } });
    await client.request({ method: "PUT", path: "/b", body: { b: 2 } });
    const init1 = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const init2 = fetchSpy.mock.calls[1]?.[1] as RequestInit;
    expect(init1.headers).toBe(init2.headers);
  });

  it("write path shares the abort signal (timeout maps to weeek_timeout)", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.reject(new DOMException("aborted", "AbortError")),
    );
    const client = createWeeekClient(makeEnvConfig({ timeoutMs: 100 }));
    let err: unknown;
    try {
      await client.request({ method: "POST", path: "/x", body: { a: 1 } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WeeekError);
    expect((err as WeeekError).code).toBe("weeek_timeout");
  });

  it("write path keeps the non-JSON-body guard (weeek_invalid_response)", async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({ status: 200, body: "<html>oops</html>" }),
    );
    const client = createWeeekClient(makeEnvConfig());
    let err: unknown;
    try {
      await client.request({ method: "POST", path: "/x", body: { a: 1 } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WeeekError);
    expect((err as WeeekError).code).toBe("weeek_invalid_response");
  });
});

// INVARIANT-2 (body side): the request body is tenant data — it never
// reaches stderr, on the happy path or on any failure path, and it is never
// carried into the thrown `WeeekError`'s message or cause. The client does
// not log at all today; this suite is the regression net that keeps it that
// way once write tools start passing real titles and descriptions through.
describe("createWeeekClient — request body never reaches the logs", () => {
  const SENTINEL = "sentinel-body-payload-do-not-log";
  const BODY = { title: SENTINEL, description: `x ${SENTINEL} y` };

  let fetchSpy: Mock<typeof fetch>;
  let stderrSpy: MockInstance<typeof process.stderr.write>;
  let loggerSpies: MockInstance<(m: string, c?: Record<string, unknown>) => void>[];

  beforeEach(() => {
    fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchSpy);
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    loggerSpies = [
      vi.spyOn(logger, "debug").mockImplementation(() => {}),
      vi.spyOn(logger, "info").mockImplementation(() => {}),
      vi.spyOn(logger, "warn").mockImplementation(() => {}),
      vi.spyOn(logger, "error").mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function expectNoLeak(err?: unknown): void {
    for (const call of stderrSpy.mock.calls) {
      const line = String(call[0]);
      expect(line).not.toContain(SENTINEL);
      // Gate E on the write path: the token rides in a second headers
      // object now, so assert it on every one of these paths too.
      expect(line).not.toContain("Bearer ");
      expect(line.toLowerCase()).not.toContain("authorization");
    }
    for (const spy of loggerSpies) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(SENTINEL);
      }
    }
    if (err instanceof Error) {
      expect(err.message).not.toContain(SENTINEL);
      expect(JSON.stringify(err.cause ?? null)).not.toContain(SENTINEL);
      expect(String(err.stack ?? "")).not.toContain(SENTINEL);
    }
  }

  it("success path emits no log line carrying the body", async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({
        status: 200,
        body: JSON.stringify({ success: true, task: { id: 1 } }),
      }),
    );
    const client = createWeeekClient(makeEnvConfig());
    await client.request({ method: "POST", path: "/tm/tasks", body: BODY });
    expectNoLeak();
  });

  it.each<[string, () => void]>([
    [
      "network error",
      () => fetchSpy.mockImplementation(() => Promise.reject(new TypeError("down"))),
    ],
    [
      "timeout",
      () =>
        fetchSpy.mockImplementation(() =>
          Promise.reject(new DOMException("aborted", "AbortError")),
        ),
    ],
    [
      "non-JSON body",
      () =>
        fetchSpy.mockResolvedValue(
          mockResponse({ status: 200, body: "<html/>" }),
        ),
    ],
    [
      "upstream 422",
      () =>
        fetchSpy.mockResolvedValue(
          mockResponse({
            status: 422,
            body: JSON.stringify({ success: false, errors: { title: ["bad"] } }),
          }),
        ),
    ],
  ])("%s path emits no log line carrying the body", async (_label, arrange) => {
    arrange();
    const client = createWeeekClient(makeEnvConfig({ timeoutMs: 100 }));
    let err: unknown;
    try {
      await client.request({ method: "POST", path: "/tm/tasks", body: BODY });
    } catch (e) {
      err = e;
    }
    expectNoLeak(err);
  });

  it("an fetch error whose own message quotes the body is not re-thrown verbatim", async () => {
    // Worst case: the platform error text itself echoes the payload. The
    // WeeekError message must still be built from the code + redacted URL.
    fetchSpy.mockImplementation(() =>
      Promise.reject(new TypeError(`failed to send ${SENTINEL}`)),
    );
    const client = createWeeekClient(makeEnvConfig());
    let err: unknown;
    try {
      await client.request({ method: "POST", path: "/tm/tasks", body: BODY });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WeeekError);
    expect((err as WeeekError).message).not.toContain(SENTINEL);
    for (const call of stderrSpy.mock.calls) {
      expect(String(call[0])).not.toContain(SENTINEL);
    }
  });
});
