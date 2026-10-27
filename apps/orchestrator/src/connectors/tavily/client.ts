import { Value } from "@sinclair/typebox/value";
import { decode } from "../../lib/decode.js";
import type { FetchFn } from "../../net/http.js";
import { ErrorBody, ErrorDetail, SearchResponse } from "./responses.js";

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

/** A field as text, trimmed; null when it is not text or is blank. */
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function formatSearch(payload: SearchResponse): string {
  const blocks: string[] = [];
  for (const row of payload.results ?? []) {
    const lines = [row.title, row.url, row.content].map(text).filter((value) => value !== null);
    if (lines.length) {
      blocks.push(lines.join("\n"));
    }
  }
  return blocks.length ? blocks.join("\n\n") : "no results";
}

/** The message of an error body, as text or one object deeper. */
function errorMessage(payload: unknown): string | null {
  if (!Value.Check(ErrorBody, payload)) {
    return null;
  }
  const detail = payload.detail ?? payload.error ?? payload.message;
  if (Value.Check(ErrorDetail, detail)) {
    return text(detail.error ?? detail.message);
  }
  return text(detail);
}

async function errorDetail(response: Response): Promise<string> {
  const body = await response.text();
  let payload: unknown;
  try {
    payload = body ? JSON.parse(body) : {};
  } catch {
    const stripped = body.trim();
    return stripped || `Tavily HTTP ${response.status}`;
  }
  return errorMessage(payload) ?? `Tavily HTTP ${response.status}`;
}

function unexpected(problem: string): TavilyError {
  return new TavilyError(`Tavily returned an unexpected response at ${problem}`);
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
  return formatSearch(decode(SearchResponse, payload, unexpected));
}
