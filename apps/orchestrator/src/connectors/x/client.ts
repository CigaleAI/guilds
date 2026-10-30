import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { decode } from "../../lib/decode.js";
import { proxyFetch, withQuery, type FetchFn } from "../../net/http.js";
import { LIST_DEFAULT, argStr, clipRows, clipText, fmtNum, joinParts, rowLimit } from "../format.js";
import type { ApiGet } from "../types.js";
import {
  ErrorBody,
  ErrorEntry,
  ErrorList,
  PostsResponse,
  UserResponse,
  type XPost,
  type XUser,
} from "./responses.js";

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

/** The item of `data`: the object itself, or the first of a list; none when it is empty. */
function dataObj<T extends object>(data: T[] | T | null | undefined): T | null {
  if (Array.isArray(data)) {
    return data[0] ?? null;
  }
  return data && Object.keys(data).length ? data : null;
}

/** The items of `data`: the list itself, or the one object; none when it is empty. */
function dataList<T extends object>(data: T[] | T | null | undefined): T[] {
  if (Array.isArray(data)) {
    return data;
  }
  return data && Object.keys(data).length ? [data] : [];
}

function usersById(payload: PostsResponse): Record<string, XUser> {
  const mapped: Record<string, XUser> = {};
  for (const user of payload.includes?.users ?? []) {
    if (user.id != null && user.id !== "") {
      mapped[String(user.id)] = user;
    }
  }
  return mapped;
}

function nextToken(payload: PostsResponse): string {
  const token = payload.meta?.next_token;
  return typeof token === "string" && token.trim() ? token.trim() : "";
}

function resultCount(payload: PostsResponse): string {
  return fmtNum(payload.meta?.result_count ?? dataList(payload.data).length);
}

function tweetText(item: XPost): string {
  const text = item.note_tweet?.text;
  if (typeof text === "string" && text.trim()) {
    return text;
  }
  return typeof item.text === "string" ? item.text : "";
}

function postRow(item: XPost, users: Record<string, XUser>): string {
  const author = users[String(item.author_id ?? "")] ?? {};
  const metrics = item.public_metrics ?? {};
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

/** The verification mark of a user: its kind, or `verified`; none when unverified. */
function verifiedMark(item: XUser): string[] {
  if (item.verified !== true) {
    return [];
  }
  const kind = item.verified_type;
  return [typeof kind === "string" && kind.trim() ? kind.trim() : "verified"];
}

export function formatUser(payload: UserResponse): string {
  const item = dataObj(payload.data);
  if (!item) {
    return "no results";
  }
  const metrics = item.public_metrics ?? {};
  const head = joinParts(
    item.id,
    handle(item.username),
    item.name,
    ...verifiedMark(item),
    `followers=${fmtNum(metrics.followers_count)}`,
    `following=${fmtNum(metrics.following_count)}`,
    `posts=${fmtNum(metrics.tweet_count)}`,
    item.created_at,
  );
  const bio = clipText(item.description, TEXT_CAP);
  return [head, bio].filter(Boolean).join("\n") || "no results";
}

export function formatPosts(payload: PostsResponse, limit = LIST_DEFAULT): string {
  const users = usersById(payload);
  const rows = dataList(payload.data).map((item) => postRow(item, users));
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

export function formatSearch(payload: PostsResponse, query: string, limit = LIST_DEFAULT): string {
  const body = formatPosts(payload, limit);
  if (body === "no results") {
    return body;
  }
  return [joinParts(query, `n=${resultCount(payload)}`), body].join("\n");
}

export function formatPost(payload: PostsResponse): string {
  const item = dataObj(payload.data);
  if (!item) {
    return "no results";
  }
  const row = postRow(item, usersById(payload));
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

function trimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The message of an error body: the first error's, else the body's own. */
function errorMessage(payload: unknown): string | null {
  if (!Value.Check(ErrorBody, payload)) {
    return null;
  }
  const errors = payload.errors;
  if (Value.Check(ErrorList, errors) && Value.Check(ErrorEntry, errors[0])) {
    const first = errors[0];
    const inner = trimmed(first.message ?? first.detail ?? first.title);
    if (inner) {
      return inner;
    }
  }
  return trimmed(payload.detail ?? payload.title ?? payload.error);
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
  return errorMessage(payload) ?? `X HTTP ${response.status}`;
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

type XOptions = { client?: FetchFn; proxyUrl?: string };

type ToolOptions = XOptions & { apiKey: string };

function unexpected(problem: string): XError {
  return new XError(`X returned an unexpected response at ${problem}`);
}

/** The response at `path` with `params`, as `schema` describes it. */
async function getJson<T extends TSchema>(
  request: ApiGet<T>,
  apiKey: string,
  options: XOptions = {},
): Promise<Static<T>> {
  const key = apiKey.trim();
  if (!key) {
    throw new XError("X bearer token is missing", 401);
  }
  const fetchFn = options.client ?? proxyFetch(options.proxyUrl ?? "");
  const response = await fetchFn(withQuery(`${API_BASE}${request.path}`, request.params), {
    method: "GET",
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  if (response.status >= 400) {
    throw new XError(await errorDetail(response), response.status);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw new XError("X returned a non-JSON body");
  }
  return decode(request.schema, payload, unexpected);
}

async function lookupUser(value: string, apiKey: string, options: XOptions = {}): Promise<UserResponse> {
  const handleValue = value.replace(/^@+/, "").trim();
  if (!handleValue) {
    throw new XError("user is required");
  }
  const path = isUserId(handleValue) ? `/users/${handleValue}` : `/users/by/username/${handleValue}`;
  return getJson({ path, params: { "user.fields": USER_FIELDS }, schema: UserResponse }, apiKey, options);
}

const PING = Type.Unknown();

export async function ping(apiKey: string, options: XOptions = {}): Promise<void> {
  await getJson({ path: `/users/by/username/${PING_USERNAME}`, params: {}, schema: PING }, apiKey, options);
}

export async function searchTool(arguments_: Record<string, unknown>, options: ToolOptions): Promise<string> {
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
  const payload = await getJson(
    { path: "/tweets/search/recent", params, schema: PostsResponse },
    options.apiKey,
    options,
  );
  return formatSearch(payload, query, limit);
}

export async function userTool(arguments_: Record<string, unknown>, options: ToolOptions): Promise<string> {
  return formatUser(await lookupUser(argStr(arguments_, "user"), options.apiKey, options));
}

/** The page with `user` among its users, so each post can name its author. */
function withAuthor(payload: PostsResponse, user: XUser): PostsResponse {
  const users = payload.includes?.users ?? [];
  return { ...payload, includes: { ...payload.includes, users: [...users, user] } };
}

export async function postsTool(arguments_: Record<string, unknown>, options: ToolOptions): Promise<string> {
  const user = await lookupUser(argStr(arguments_, "user"), options.apiKey, options);
  const item = dataObj(user.data);
  const userId = item ? String(item.id ?? "").trim() : "";
  if (!item || !userId) {
    throw new XError("user not found");
  }
  const limit = rowLimit(arguments_);
  const params = tweetParams(Math.max(TIMELINE_MIN, Math.min(100, limit)));
  const pageKey = argStr(arguments_, "page_key");
  if (pageKey) {
    params.pagination_token = pageKey;
  }
  const payload = await getJson(
    { path: `/users/${userId}/tweets`, params, schema: PostsResponse },
    options.apiKey,
    options,
  );
  const page = userId in usersById(payload) ? payload : withAuthor(payload, item);
  return formatPosts(page, limit);
}

export async function postTool(arguments_: Record<string, unknown>, options: ToolOptions): Promise<string> {
  const tweetId = postId(argStr(arguments_, "id"));
  const payload = await getJson(
    { path: `/tweets/${tweetId}`, params: tweetParams(), schema: PostsResponse },
    options.apiKey,
    options,
  );
  return formatPost(payload);
}

const HANDLERS: Record<string, (arguments_: Record<string, unknown>, options: ToolOptions) => Promise<string>> = {
  search: searchTool,
  user: userTool,
  posts: postsTool,
  post: postTool,
};

export async function callTool(
  name: string,
  arguments_: Record<string, unknown>,
  options: ToolOptions,
): Promise<string> {
  const handler = HANDLERS[name];
  if (!handler) {
    throw new XError(`unknown X tool ${name}`);
  }
  return handler(arguments_, options);
}
