import { vi } from "vitest";
import type {
  WeeekClient,
  WeeekRequest,
  WeeekRawResponse,
} from "../../src/weeek/client.js";

type ResponseFactory =
  | WeeekRawResponse
  | (() => WeeekRawResponse | Promise<WeeekRawResponse>);

export interface MockWeeekClient {
  client: WeeekClient;
  requests: () => WeeekRequest[];
  whenRequest: (
    method: WeeekRequest["method"],
    path: string,
    response: ResponseFactory,
  ) => void;
  // Default response when no `whenRequest` matches. Last-write-wins.
  setDefault: (response: ResponseFactory) => void;
  // Make every subsequent request reject with the given error (overrides
  // any registered responses). Used to drive WeeekError handling in tools.
  rejectAll: (error: unknown) => void;
}

function keyFor(method: WeeekRequest["method"], path: string): string {
  return `${method} ${path}`;
}

async function resolve(r: ResponseFactory): Promise<WeeekRawResponse> {
  if (typeof r === "function") {
    return Promise.resolve(r());
  }
  return r;
}

export function makeMockWeeekClient(): MockWeeekClient {
  const responses = new Map<string, ResponseFactory>();
  const requests: WeeekRequest[] = [];
  let defaultResponse: ResponseFactory | undefined;
  let rejection: { error: unknown } | undefined;

  const request = vi.fn(async (req: WeeekRequest): Promise<WeeekRawResponse> => {
    requests.push(req);
    if (rejection) throw rejection.error;
    const exact = responses.get(keyFor(req.method, req.path));
    if (exact !== undefined) return resolve(exact);
    if (defaultResponse !== undefined) return resolve(defaultResponse);
    throw new Error(
      `MockWeeekClient: no response registered for ${req.method} ${req.path}`,
    );
  });

  const client: WeeekClient = { request };

  return {
    client,
    requests: () => requests.slice(),
    whenRequest(method, path, response) {
      responses.set(keyFor(method, path), response);
    },
    setDefault(response) {
      defaultResponse = response;
    },
    rejectAll(error) {
      rejection = { error };
    },
  };
}
