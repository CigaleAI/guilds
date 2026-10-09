import { ProxyAgent, fetch as undiciFetch } from "undici";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export type HttpClientOptions = {
  timeoutMs?: number;
  proxyUrl?: string;
  signal?: AbortSignal;
};

export function withQuery(url: string, params: Record<string, string> = {}): string {
  const encoded = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    encoded.set(key, value);
  }
  const query = encoded.toString();
  if (!query) {
    return url;
  }
  return url.includes("?") ? `${url}&${query}` : `${url}?${query}`;
}

export async function httpRequest(
  url: string,
  init: RequestInit = {},
  options: HttpClientOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  const proxyUrl = (options.proxyUrl ?? "").trim();
  try {
    if (proxyUrl) {
      const dispatcher = new ProxyAgent(proxyUrl);
      return (await undiciFetch(url, {
        ...init,
        signal: controller.signal,
        dispatcher,
      } as never)) as unknown as Response;
    }
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export function proxyFetch(proxyUrl = "", timeoutMs = 30_000): FetchFn {
  return (url, init) => httpRequest(url, init ?? {}, { proxyUrl, timeoutMs });
}

export async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}
