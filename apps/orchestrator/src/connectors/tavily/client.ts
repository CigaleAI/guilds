import { Value } from "@sinclair/typebox/value";
import type { FetchFn } from "../../net/http.js";
import { decodeResponse, type ConnectorApi } from "../response.js";
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

/** Text, trimmed; null when it is blank or absent. */
function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
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
function errorMessage(body: ErrorBody): string | null {
  const detail = body.detail ?? body.error ?? body.message;
  return Value.Check(ErrorDetail, detail) ? text(detail.error ?? detail.message) : text(detail);
}

/** Tavily's API as the client reads its responses. */
const TAVILY: ConnectorApi<typeof ErrorBody> = {
  name: "Tavily",
  error: (message, status) => new TavilyError(message, status),
  errorBody: ErrorBody,
  errorMessage,
};

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
  return formatSearch(await decodeResponse(TAVILY, response, SearchResponse));
}
