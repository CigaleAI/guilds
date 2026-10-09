import { proxyFetch, withQuery, type FetchFn } from "../../net/http.js";
import { LIST_DEFAULT, argStr, clipRows, clipText, fmtNum, joinParts, rowLimit } from "../format.js";

export const API_BASE = "https://api.x.com/2";
export const PING_USERNAME = "X";
export const TEXT_CAP = 280;
export const SEARCH_MIN = 10;
export const TIMELINE_MIN = 5;
export const TWEET_FIELDS = "created_at,public_metrics,conversation_id,note_tweet";
export const USER_FIELDS = "username,name,created_at,description,public_metrics,verified,verified_type";
const STATUS_ID = /(?:status\/)?(\d{5,25})\s*$/i;

export class XError extends Error {
  status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "XError";
    this.status = status;
  }
}

export function postId(value: string): string {
  const text = value.trim().split("#", 1)[0]!.split("?", 1)[0]!;
  const match = STATUS_ID.exec(text);
  if (match?.[1]) {
    return match[1];
  }
  throw new XError("id must be a post id or status URL");
}

export function isUserId(value: string): boolean {
  return /^\d+$/.test(value) && value.length >= 5;
}

function handle(value: unknown): string {
  const text = String(value || "").trim().replace(/^@+/, "");
  return text ? `@${text}` : "";
}

function dataObj(payload: Record<string, unknown>): Record<string, unknown> | null {
  const data = payload.data;
  if (data && typeof data === "object" && !Array.isArray(data) && Object.keys(data).length) {
    return data as Record<string, unknown>;
  }
  if (Array.isArray(data) && data.length && data[0] && typeof data[0] === "object" && !Array.isArray(data[0])) {
    return data[0] as Record<string, unknown>;
  }
  return null;
}

function dataList(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const data = payload.data;
  if (Array.isArray(data)) {
    return data.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  }
  if (data && typeof data === "object" && Object.keys(data).length) {
    return [data as Record<string, unknown>];
  }
  return [];
}

function usersById(payload: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const includes =
    payload.includes && typeof payload.includes === "object" && !Array.isArray(payload.includes)
      ? (payload.includes as Record<string, unknown>)
      : null;
  const users = includes?.users;
  if (!Array.isArray(users)) {
    return {};
  }
  const mapped: Record<string, Record<string, unknown>> = {};
  for (const user of users) {
    if (user && typeof user === "object" && !Array.isArray(user) && (user as { id?: unknown }).id != null && (user as { id?: unknown }).id !== "") {
      mapped[String((user as { id: unknown }).id)] = user as Record<string, unknown>;
    }
  }
  return mapped;
}

function nextToken(payload: Record<string, unknown>): string {
  const meta =
    payload.meta && typeof payload.meta === "object" && !Array.isArray(payload.meta)
      ? (payload.meta as Record<string, unknown>)
      : null;
  const token = meta?.next_token;
  return typeof token === "string" && token.trim() ? token.trim() : "";
}

function resultCount(payload: Record<string, unknown>): string {
  const meta =
    payload.meta && typeof payload.meta === "object" && !Array.isArray(payload.meta)
      ? (payload.meta as Record<string, unknown>)
      : null;
  let count = meta?.result_count;
  if (count === null || count === undefined) {
    count = dataList(payload).length;
  }
  return fmtNum(count);
}

function tweetText(item: Record<string, unknown>): string {
  const note = item.note_tweet;
  if (note && typeof note === "object" && !Array.isArray(note)) {
    const text = (note as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) {
      return text;
    }
  }
  return typeof item.text === "string" ? item.text : "";
}

function postRow(item: Record<string, unknown>, users: Record<string, Record<string, unknown>>): string {
  const author = users[String(item.author_id ?? "")] ?? {};
  const metrics =
    item.public_metrics && typeof item.public_metrics === "object" && !Array.isArray(item.public_metrics)
      ? (item.public_metrics as Record<string, unknown>)
      : {};
  return joinParts(
    item.id,
    handle(author.username),
    author.name,
    item.created_at,
    `likes=${fmtNum(metrics.like_count)}`,
    `rts=${fmtNum(metrics.retweet_count)}`,
    `replies=${fmtNum(metrics.reply_count)}`,
    `quotes=${fmtNum(metrics.quote_count)}`,
    clipText(tweetText(item), TEXT_CAP),
  );
}

export function formatUser(payload: Record<string, unknown>): string {
  const item = dataObj(payload);
  if (!item) {
    return "no results";
  }
  const metrics =
    item.public_metrics && typeof item.public_metrics === "object" && !Array.isArray(item.public_metrics)
      ? (item.public_metrics as Record<string, unknown>)
      : {};
  const marks: string[] = [];
  if (item.verified === true) {
    const kind = item.verified_type;
    marks.push(typeof kind === "string" && kind.trim() ? kind.trim() : "verified");
  }
  const head = joinParts(
    item.id,
    handle(item.username),
    item.name,
    ...marks,
    `followers=${fmtNum(metrics.followers_count)}`,
    `following=${fmtNum(metrics.following_count)}`,
    `posts=${fmtNum(metrics.tweet_count)}`,
    item.created_at,
  );
  const bio = clipText(item.description, TEXT_CAP);
  return [head, bio].filter(Boolean).join("\n") || "no results";
}

export function formatPosts(payload: Record<string, unknown>, options: { limit?: number } = {}): string {
  const limit = options.limit ?? LIST_DEFAULT;
  const items = dataList(payload);
  const users = usersById(payload);
  const rows = items.map((item) => postRow(item, users));
  const body = clipRows(rows.filter(Boolean), limit);
  if (body === "no results") {
    return body;
  }
  const parts = [body];
  const token = nextToken(payload);
  if (token) {
    parts.push(`page=${token}`);
  }
  return parts.join("\n");
}

export function formatSearch(
  payload: Record<string, unknown>,
  options: { query: string; limit?: number },
): string {
  const body = options.limit === undefined ? formatPosts(payload) : formatPosts(payload, { limit: options.limit });
  if (body === "no results") {
    return body;
  }
  return [joinParts(options.query, `n=${resultCount(payload)}`), body].join("\n");
}

export function formatPost(payload: Record<string, unknown>): string {
  const item = dataObj(payload);
  if (!item) {
    return "no results";
  }
  const users = usersById(payload);
  const row = postRow(item, users);
  const conversation = item.conversation_id;
  let extra = "";
  if (
    typeof conversation === "string"
    && conversation.trim()
    && conversation.trim() !== String(item.id ?? "").trim()
  ) {
    extra = `conversation=${conversation.trim()}`;
  }
  return [row, extra].filter(Boolean).join("\n") || "no results";
}

async function errorDetail(response: Response): Promise<string> {
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    const stripped = text.trim();
    return stripped || `X HTTP ${response.status}`;
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const errors = (payload as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length) {
      const first = errors[0];
      if (first && typeof first === "object" && !Array.isArray(first)) {
        const inner =
          (first as { message?: unknown; detail?: unknown; title?: unknown }).message
          ?? (first as { detail?: unknown }).detail
          ?? (first as { title?: unknown }).title;
        if (typeof inner === "string" && inner.trim()) {
          return inner.trim();
        }
      }
    }
    const detail =
      (payload as { detail?: unknown; title?: unknown; error?: unknown }).detail
      ?? (payload as { title?: unknown }).title
      ?? (payload as { error?: unknown }).error;
    if (typeof detail === "string" && detail.trim()) {
      return detail.trim();
    }
  }
  return `X HTTP ${response.status}`;
}

function tweetParams(maxResults?: number): Record<string, string> {
  const params: Record<string, string> = {
    "tweet.fields": TWEET_FIELDS,
    expansions: "author_id",
    "user.fields": "username,name",
  };
  if (maxResults !== undefined) {
    params.max_results = String(maxResults);
  }
  return params;
}

async function getJson(
  path: string,
  params: Record<string, string>,
  apiKey: string,
  options: { client?: FetchFn; proxyUrl?: string } = {},
): Promise<unknown> {
  const key = apiKey.trim();
  if (!key) {
    throw new XError("X bearer token is missing", 401);
  }
  const fetchFn = options.client ?? proxyFetch(options.proxyUrl ?? "");
  const response = await fetchFn(withQuery(`${API_BASE}${path}`, params), {
    method: "GET",
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  if (response.status >= 400) {
    throw new XError(await errorDetail(response), response.status);
  }
  try {
    return JSON.parse(await response.text());
  } catch {
    throw new XError("X returned a non-JSON body");
  }
}

async function lookupUser(
  value: string,
  apiKey: string,
  options: { client?: FetchFn; proxyUrl?: string } = {},
): Promise<Record<string, unknown>> {
  const handleValue = value.replace(/^@+/, "").trim();
  if (!handleValue) {
    throw new XError("user is required");
  }
  const path = isUserId(handleValue) ? `/users/${handleValue}` : `/users/by/username/${handleValue}`;
  const payload = await getJson(path, { "user.fields": USER_FIELDS }, apiKey, options);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new XError("X returned a non-object");
  }
  return payload as Record<string, unknown>;
}

export async function ping(
  apiKey: string,
  options: { client?: FetchFn; proxyUrl?: string } = {},
): Promise<void> {
  await getJson(`/users/by/username/${PING_USERNAME}`, {}, apiKey, options);
}

export async function searchTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const query = argStr(arguments_, "query");
  if (!query) {
    throw new XError("query is required");
  }
  const limit = rowLimit(arguments_);
  const params = tweetParams(Math.max(SEARCH_MIN, Math.min(100, limit)));
  params.query = query;
  const pageKey = argStr(arguments_, "page_key");
  if (pageKey) {
    params.pagination_token = pageKey;
  }
  const payload = await getJson("/tweets/search/recent", params, options.apiKey, options);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new XError("X returned a non-object");
  }
  return formatSearch(payload as Record<string, unknown>, { query, limit });
}

export async function userTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const payload = await lookupUser(argStr(arguments_, "user"), options.apiKey, options);
  return formatUser(payload);
}

export async function postsTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const userPayload = await lookupUser(argStr(arguments_, "user"), options.apiKey, options);
  const item = dataObj(userPayload);
  const userId = item ? String(item.id ?? "").trim() : "";
  if (!userId) {
    throw new XError("user not found");
  }
  const limit = rowLimit(arguments_);
  const params = tweetParams(Math.max(TIMELINE_MIN, Math.min(100, limit)));
  const pageKey = argStr(arguments_, "page_key");
  if (pageKey) {
    params.pagination_token = pageKey;
  }
  const payload = await getJson(`/users/${userId}/tweets`, params, options.apiKey, options);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new XError("X returned a non-object");
  }
  const body = payload as Record<string, unknown>;
  const users = usersById(body);
  if (item && !(userId in users)) {
    const includes =
      body.includes && typeof body.includes === "object" && !Array.isArray(body.includes)
        ? (body.includes as Record<string, unknown>)
        : null;
    if (!includes) {
      body.includes = { users: [item] };
    } else {
      const existing = includes.users;
      if (Array.isArray(existing)) {
        existing.push(item);
      } else {
        includes.users = [item];
      }
    }
  }
  return formatPosts(body, { limit });
}

export async function postTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const tweetId = postId(argStr(arguments_, "id"));
  const payload = await getJson(`/tweets/${tweetId}`, tweetParams(), options.apiKey, options);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new XError("X returned a non-object");
  }
  return formatPost(payload as Record<string, unknown>);
}

const HANDLERS: Record<
  string,
  (
    arguments_: Record<string, unknown>,
    options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
  ) => Promise<string>
> = {
  search: searchTool,
  user: userTool,
  posts: postsTool,
  post: postTool,
};

export async function callTool(
  name: string,
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const handler = HANDLERS[name];
  if (!handler) {
    throw new XError(`unknown X tool ${name}`);
  }
  return handler(arguments_, options);
}
