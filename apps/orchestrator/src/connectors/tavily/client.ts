import type { FetchFn } from "../../net/http.js";

export const BASE_URL = "https://api.tavily.com";
const SEARCH_URL = `${BASE_URL}/search`;

export class TavilyError extends Error {
  status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "TavilyError";
    this.status = status;
  }
}

export function formatSearch(payload: Record<string, unknown>): string {
  const results = payload.results;
  if (!Array.isArray(results) || results.length === 0) {
    return "no results";
  }
  const blocks: string[] = [];
  for (const item of results) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const lines = [row.title, row.url, row.content]
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      .map((value) => value.trim());
    if (lines.length) {
      blocks.push(lines.join("\n"));
    }
  }
  return blocks.length ? blocks.join("\n\n") : "no results";
}

async function errorDetail(response: Response): Promise<string> {
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    const stripped = text.trim();
    return stripped || `Tavily HTTP ${response.status}`;
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const detail = (payload as { detail?: unknown; error?: unknown; message?: unknown }).detail
      ?? (payload as { error?: unknown }).error
      ?? (payload as { message?: unknown }).message;
    if (typeof detail === "string" && detail.trim()) {
      return detail.trim();
    }
    if (detail && typeof detail === "object" && !Array.isArray(detail)) {
      const inner = (detail as { error?: unknown; message?: unknown }).error
        ?? (detail as { message?: unknown }).message;
      if (typeof inner === "string" && inner.trim()) {
        return inner.trim();
      }
    }
  }
  return `Tavily HTTP ${response.status}`;
}

export type SearchOptions = {
  apiKey: string;
  client: FetchFn;
};

/** One Tavily search: title, URL, and snippet per source. */
export async function search(query: string, options: SearchOptions): Promise<string> {
  const stripped = query.trim();
  if (!stripped) {
    throw new TavilyError("query is required");
  }
  const response = await options.client(SEARCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: stripped, search_depth: "advanced" }),
  });
  if (response.status >= 400) {
    throw new TavilyError(await errorDetail(response), response.status);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw new TavilyError("Tavily returned a non-JSON body");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TavilyError("Tavily returned a non-object");
  }
  return formatSearch(payload as Record<string, unknown>);
}
