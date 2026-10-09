import type { FetchFn } from "../../src/net/http.js";

export type MockResult = {
  status: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
};

export function mockFetch(
  handler: (url: string, init?: RequestInit) => MockResult | Promise<MockResult>,
): FetchFn {
  return async (url, init) => {
    const result = await handler(url, init);
    const body = result.text ?? (result.json !== undefined ? JSON.stringify(result.json) : "");
    return new Response(body, {
      status: result.status,
      headers: { "content-type": "application/json", ...result.headers },
    });
  };
}
