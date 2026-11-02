import type { Static, TSchema } from "@sinclair/typebox";
import { proxyFetch, withQuery, type FetchFn } from "../../net/http.js";
import { decodeResponse, type ConnectorApi } from "../response.js";
import { LIST_DEFAULT, clipRows, clipText, fmtNum, joinParts } from "../format.js";
import type { ApiGet } from "../types.js";
import {
  ErrorBody,
  PostResponse,
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

/** The query every request for posts carries: the fields of each post, and its author expanded. */
const POST_QUERY = {
  "tweet.fields": TWEET_FIELDS,
  expansions: "author_id",
  "user.fields": "username,name",
} as const;

export class XError extends Error {
  status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "XError";
    this.status = status;
  }
}

/** The page of a list a call asks for: how many rows it shows, and the token of the page to start at. */
export type ListPage = { rows: number; token: string | undefined };

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

/** Text, trimmed; null when it is blank or absent. */
function text(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function handle(username: string | undefined): string {
  const name = username?.trim().replace(/^@+/, "") ?? "";
  return name ? `@${name}` : "";
}

/** The users a response names, by id. */
function usersById(users: readonly XUser[] | undefined): Map<string, XUser> {
  return new Map((users ?? []).filter((user) => user.id !== "").map((user) => [user.id, user]));
}

/** A post's text: its long form when it has one. */
function tweetText(item: XPost): string {
  const long = item.note_tweet?.text;
  return long?.trim() ? long : item.text;
}

function postRow(item: XPost, users: Map<string, XUser>): string {
  const author = users.get(item.author_id ?? "");
  const metrics = item.public_metrics;
  return joinParts(
    item.id,
    handle(author?.username),
    author?.name,
    item.created_at,
    `likes=${fmtNum(metrics?.like_count)}`,
    `rts=${fmtNum(metrics?.retweet_count)}`,
    `replies=${fmtNum(metrics?.reply_count)}`,
    `quotes=${fmtNum(metrics?.quote_count)}`,
    clipText(tweetText(item), TEXT_CAP),
  );
}

/** The verification mark of a user: its kind, or `verified`; none when unverified. */
function verifiedMark(item: XUser): string[] {
  return item.verified === true ? [text(item.verified_type) ?? "verified"] : [];
}

export function formatUser(payload: UserResponse): string {
  const item = payload.data;
  if (!item) {
    return "no results";
  }
  const metrics = item.public_metrics;
  const head = joinParts(
    item.id,
    handle(item.username),
    item.name,
    ...verifiedMark(item),
    `followers=${fmtNum(metrics?.followers_count)}`,
    `following=${fmtNum(metrics?.following_count)}`,
    `posts=${fmtNum(metrics?.tweet_count)}`,
    item.created_at,
  );
  const bio = clipText(item.description, TEXT_CAP);
  return [head, bio].filter(Boolean).join("\n") || "no results";
}

export function formatPosts(payload: PostsResponse, limit = LIST_DEFAULT): string {
  const users = usersById(payload.includes?.users);
  const rows = (payload.data ?? []).map((item) => postRow(item, users));
  const body = clipRows(rows.filter(Boolean), limit);
  if (body === "no results") {
    return body;
  }
  const token = text(payload.meta?.next_token);
  return token ? `${body}\npage=${token}` : body;
}

export function formatSearch(payload: PostsResponse, query: string, limit = LIST_DEFAULT): string {
  const body = formatPosts(payload, limit);
  if (body === "no results") {
    return body;
  }
  const count = payload.meta?.result_count ?? payload.data?.length;
  return [joinParts(query, `n=${fmtNum(count)}`), body].join("\n");
}

export function formatPost(payload: PostResponse): string {
  const item = payload.data;
  if (!item) {
    return "no results";
  }
  const row = postRow(item, usersById(payload.includes?.users));
  const conversation = text(item.conversation_id);
  const extra = conversation && conversation !== item.id.trim() ? `conversation=${conversation}` : "";
  return [row, extra].filter(Boolean).join("\n") || "no results";
}

/** The message of an error body: the first error's, else the body's own. */
function errorMessage(body: ErrorBody): string | null {
  const first = body.errors?.[0];
  return text(first?.message ?? first?.detail ?? first?.title) ?? text(body.detail ?? body.title ?? body.error);
}

/** X's API as the client reads its responses. */
const X_API: ConnectorApi<typeof ErrorBody> = {
  name: "X",
  error: (message, status) => new XError(message, status),
  errorBody: ErrorBody,
  errorMessage,
};

/** The query of a page of posts: the post fields, `max_results`, and the token of the page to start at. */
function pageQuery(maxResults: number, page: ListPage) {
  const query = { ...POST_QUERY, max_results: String(maxResults) };
  return page.token ? { ...query, pagination_token: page.token } : query;
}

type XOptions = { client?: FetchFn; proxyUrl?: string };

type ToolOptions = XOptions & { apiKey: string };

/** The response at the request's path with its query, as its schema describes it. */
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
  return decodeResponse(X_API, response, request.schema);
}

async function lookupUser(value: string, apiKey: string, options: XOptions = {}): Promise<UserResponse> {
  const handleValue = value.replace(/^@+/, "").trim();
  if (!handleValue) {
    throw new XError("user is required");
  }
  const path = isUserId(handleValue) ? `/users/${handleValue}` : `/users/by/username/${handleValue}`;
  return getJson({ path, params: { "user.fields": USER_FIELDS }, schema: UserResponse }, apiKey, options);
}

export async function ping(apiKey: string, options: XOptions = {}): Promise<void> {
  await getJson({ path: `/users/by/username/${PING_USERNAME}`, params: {}, schema: UserResponse }, apiKey, options);
}

/** Recent posts matching `query`. */
export async function search(query: string, page: ListPage, options: ToolOptions): Promise<string> {
  const stripped = query.trim();
  if (!stripped) {
    throw new XError("query is required");
  }
  const params = { ...pageQuery(Math.max(SEARCH_MIN, Math.min(100, page.rows)), page), query: stripped };
  const payload = await getJson(
    { path: "/tweets/search/recent", params, schema: PostsResponse },
    options.apiKey,
    options,
  );
  return formatSearch(payload, stripped, page.rows);
}

/** One profile, by username or user id. */
export async function user(value: string, options: ToolOptions): Promise<string> {
  return formatUser(await lookupUser(value, options.apiKey, options));
}

/** The page with `author` among its users, so each post can name its author. */
function withAuthor(payload: PostsResponse, author: XUser): PostsResponse {
  const users = payload.includes?.users ?? [];
  return { ...payload, includes: { ...payload.includes, users: [...users, author] } };
}

/** Recent posts of one account, by username or user id. */
export async function posts(value: string, page: ListPage, options: ToolOptions): Promise<string> {
  const author = (await lookupUser(value, options.apiKey, options)).data;
  const userId = author?.id.trim() ?? "";
  if (!author || !userId) {
    throw new XError("user not found");
  }
  const payload = await getJson(
    {
      path: `/users/${userId}/tweets`,
      params: pageQuery(Math.max(TIMELINE_MIN, Math.min(100, page.rows)), page),
      schema: PostsResponse,
    },
    options.apiKey,
    options,
  );
  const named = usersById(payload.includes?.users).has(userId);
  return formatPosts(named ? payload : withAuthor(payload, author), page.rows);
}

/** One post, by id or status URL. */
export async function post(value: string, options: ToolOptions): Promise<string> {
  const payload = await getJson(
    { path: `/tweets/${postId(value)}`, params: POST_QUERY, schema: PostResponse },
    options.apiKey,
    options,
  );
  return formatPost(payload);
}
