import { proxyFetch, withQuery, type FetchFn } from "../../net/http.js";
import { LIST_DEFAULT, argStr, clipRows, clipText, fmtNum, joinParts, rowLimit } from "../format.js";

export const API_BASE = "https://api.twitterapi.io";
export const TEXT_CAP = 280;
export const STATUS_ID = /(?:status\/)?(\d{5,25})\s*$/i;
export const WORLDWIDE_WOEID = "1";
export const SEARCH_QUERY_TYPE = "Top";
export const SEARCH_WINDOW = "within_time:24h";
const SEARCH_TIME_OPERATOR = /\b(?:within_time|since_time|until_time|since|until):\S+/gi;

export class TwitterApiIoError extends Error {
  status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "TwitterApiIoError";
    this.status = status;
  }
}

export function postId(value: string): string {
  const text = value.trim().split("#", 1)[0]!.split("?", 1)[0]!;
  const match = STATUS_ID.exec(text);
  if (match?.[1]) {
    return match[1];
  }
  throw new TwitterApiIoError("id must be a post id or status URL");
}

export function isUserId(value: string): boolean {
  return /^\d+$/.test(value) && value.length >= 5;
}

function handle(value: unknown): string {
  const text = String(value || "").trim().replace(/^@+/, "");
  return text ? `@${text}` : "";
}

function screenName(value: unknown): string {
  return String(value || "").trim().replace(/^@+/, "");
}

function asObj(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asList(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is Record<string, unknown> =>
    Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
}

function dataObj(payload: Record<string, unknown>): Record<string, unknown> | null {
  return asObj(payload.data);
}

function pick(item: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (item[key] !== undefined && item[key] !== null && item[key] !== "") {
      return item[key];
    }
  }
  return undefined;
}

function authorOf(item: Record<string, unknown>): Record<string, unknown> {
  return asObj(item.author) ?? asObj(item.user) ?? {};
}

function tweetsOf(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const top = asList(payload.tweets);
  if (top.length) {
    return top;
  }
  const data = payload.data;
  if (Array.isArray(data)) {
    return asList(data);
  }
  const wrapped = asObj(data);
  if (wrapped) {
    const inner = asList(wrapped.tweets);
    if (inner.length) {
      return inner;
    }
  }
  return [];
}

function usersOf(payload: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const top = asList(payload[key]);
  if (top.length) {
    return top;
  }
  const data = payload.data;
  if (Array.isArray(data)) {
    return asList(data);
  }
  const wrapped = asObj(data);
  if (wrapped) {
    return asList(wrapped[key]);
  }
  return [];
}

function trendsOf(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const top = asList(payload.trends);
  if (top.length) {
    return top;
  }
  const data = payload.data;
  if (Array.isArray(data)) {
    return asList(data);
  }
  const wrapped = asObj(data);
  if (wrapped) {
    return asList(wrapped.trends);
  }
  return [];
}

function pageKeyOf(payload: Record<string, unknown>): string {
  const data = asObj(payload.data);
  const hasNext = payload.has_next_page ?? data?.has_next_page;
  const cursor = payload.next_cursor ?? data?.next_cursor;
  if (hasNext === false) {
    return "";
  }
  return typeof cursor === "string" && cursor.trim() ? cursor.trim() : "";
}

function withPage(body: string, payload: Record<string, unknown>): string {
  if (body === "no results") {
    return body;
  }
  const token = pageKeyOf(payload);
  return token ? `${body}\npage=${token}` : body;
}

function postRow(item: Record<string, unknown>): string {
  const author = authorOf(item);
  return joinParts(
    pick(item, "id"),
    handle(pick(author, "userName", "username", "screen_name")),
    pick(author, "name"),
    pick(item, "createdAt", "created_at"),
    `likes=${fmtNum(pick(item, "likeCount", "likes", "like_count"))}`,
    `rts=${fmtNum(pick(item, "retweetCount", "retweets", "retweet_count"))}`,
    `replies=${fmtNum(pick(item, "replyCount", "replies", "reply_count"))}`,
    `quotes=${fmtNum(pick(item, "quoteCount", "quotes", "quote_count"))}`,
    clipText(pick(item, "text"), TEXT_CAP),
  );
}

function userRow(item: Record<string, unknown>): string {
  const marks: string[] = [];
  if (item.isBlueVerified === true || item.verified === true) {
    const kind = pick(item, "verifiedType", "verified_type");
    marks.push(typeof kind === "string" && kind.trim() ? kind.trim() : "verified");
  }
  return joinParts(
    pick(item, "id"),
    handle(pick(item, "userName", "username", "screen_name")),
    pick(item, "name"),
    ...marks,
    `followers=${fmtNum(pick(item, "followers", "followers_count"))}`,
    `following=${fmtNum(pick(item, "following", "friends_count", "following_count"))}`,
    `posts=${fmtNum(pick(item, "statusesCount", "statuses_count", "tweet_count"))}`,
    pick(item, "createdAt", "created_at"),
  );
}

export function formatUser(payload: Record<string, unknown>): string {
  const item = dataObj(payload) ?? asObj(payload.user) ?? (asObj(payload.id ? payload : null));
  if (!item || pick(item, "id", "userName", "username") === undefined) {
    return "no results";
  }
  const head = userRow(item);
  const bio = clipText(pick(item, "description", "bio"), TEXT_CAP);
  return [head, bio].filter(Boolean).join("\n") || "no results";
}

export function formatPosts(payload: Record<string, unknown>, options: { limit?: number } = {}): string {
  const limit = options.limit ?? LIST_DEFAULT;
  const rows = tweetsOf(payload).map(postRow).filter(Boolean);
  return withPage(clipRows(rows, limit), payload);
}

export function formatSearch(
  payload: Record<string, unknown>,
  options: { query: string; limit?: number },
): string {
  const body = options.limit === undefined ? formatPosts(payload) : formatPosts(payload, { limit: options.limit });
  if (body === "no results") {
    return body;
  }
  const count = tweetsOf(payload).length;
  return [joinParts(options.query, `n=${fmtNum(count)}`), body].join("\n");
}

export function formatPost(payload: Record<string, unknown>): string {
  const tweets = tweetsOf(payload);
  const item = tweets[0] ?? dataObj(payload) ?? asObj(payload.tweet);
  if (!item) {
    return "no results";
  }
  const row = postRow(item);
  const conversation = pick(item, "conversationId", "conversation_id");
  let extra = "";
  if (
    typeof conversation === "string"
    && conversation.trim()
    && conversation.trim() !== String(pick(item, "id") ?? "").trim()
  ) {
    extra = `conversation=${conversation.trim()}`;
  }
  return [row, extra].filter(Boolean).join("\n") || "no results";
}

export function formatUsers(
  payload: Record<string, unknown>,
  key: string,
  options: { limit?: number } = {},
): string {
  const limit = options.limit ?? LIST_DEFAULT;
  const rows = usersOf(payload, key).map(userRow).filter(Boolean);
  return withPage(clipRows(rows, limit), payload);
}

export function formatTrends(payload: Record<string, unknown>, options: { limit?: number } = {}): string {
  const limit = options.limit ?? LIST_DEFAULT;
  const rows = trendsOf(payload).map((item) =>
    joinParts(pick(item, "name"), `tweets=${fmtNum(pick(item, "tweetCount", "tweet_volume", "tweet_count"))}`),
  ).filter(Boolean);
  return clipRows(rows, limit);
}

async function errorDetail(response: Response): Promise<string> {
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    const stripped = text.trim();
    return stripped || `TwitterAPI.io HTTP ${response.status}`;
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const detail =
      (payload as { detail?: unknown; msg?: unknown; message?: unknown; error?: unknown }).detail
      ?? (payload as { msg?: unknown }).msg
      ?? (payload as { message?: unknown }).message
      ?? (payload as { error?: unknown }).error;
    if (typeof detail === "string" && detail.trim()) {
      return detail.trim();
    }
    if (Array.isArray(detail) && detail.length) {
      const first = detail[0];
      if (first && typeof first === "object" && !Array.isArray(first)) {
        const inner = (first as { msg?: unknown; message?: unknown }).msg
          ?? (first as { message?: unknown }).message;
        if (typeof inner === "string" && inner.trim()) {
          return inner.trim();
        }
      }
    }
  }
  return `TwitterAPI.io HTTP ${response.status}`;
}

function assertSuccess(payload: Record<string, unknown>): void {
  const status = payload.status;
  if (typeof status === "string" && status.toLowerCase() === "error") {
    const message = payload.msg ?? payload.message ?? payload.error;
    throw new TwitterApiIoError(
      typeof message === "string" && message.trim() ? message.trim() : "TwitterAPI.io returned an error",
    );
  }
}

async function getJson(
  path: string,
  params: Record<string, string>,
  apiKey: string,
  options: { client?: FetchFn; proxyUrl?: string } = {},
): Promise<Record<string, unknown>> {
  const key = apiKey.trim();
  if (!key) {
    throw new TwitterApiIoError("TwitterAPI.io API key is missing", 401);
  }
  const fetchFn = options.client ?? proxyFetch(options.proxyUrl ?? "");
  const response = await fetchFn(withQuery(`${API_BASE}${path}`, params), {
    method: "GET",
    headers: { "x-api-key": key, Accept: "application/json" },
  });
  if (response.status >= 400) {
    throw new TwitterApiIoError(await errorDetail(response), response.status);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw new TwitterApiIoError("TwitterAPI.io returned a non-JSON body");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TwitterApiIoError("TwitterAPI.io returned a non-object");
  }
  const body = payload as Record<string, unknown>;
  assertSuccess(body);
  return body;
}

function userParam(value: string): Record<string, string> {
  const handleValue = screenName(value);
  if (!handleValue) {
    throw new TwitterApiIoError("user is required");
  }
  if (isUserId(handleValue)) {
    return { userId: handleValue };
  }
  return { userName: handleValue };
}

function userNameParam(value: string): Record<string, string> {
  const handleValue = screenName(value);
  if (!handleValue) {
    throw new TwitterApiIoError("user is required");
  }
  return { userName: handleValue };
}

function cursorParams(arguments_: Record<string, unknown>): Record<string, string> {
  const pageKey = argStr(arguments_, "page_key");
  return pageKey ? { cursor: pageKey } : {};
}

function pageSize(arguments_: Record<string, unknown>): string {
  return String(Math.max(20, Math.min(200, rowLimit(arguments_))));
}

export function constrainSearchQuery(query: string): string {
  const stripped = query.replace(SEARCH_TIME_OPERATOR, " ").replace(/\s+/g, " ").trim();
  if (!stripped) {
    throw new TwitterApiIoError("query is required");
  }
  return `${stripped} ${SEARCH_WINDOW}`;
}

export async function ping(
  apiKey: string,
  options: { client?: FetchFn; proxyUrl?: string } = {},
): Promise<void> {
  await getJson("/oapi/my/info", {}, apiKey, options);
}

export async function searchTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const query = constrainSearchQuery(argStr(arguments_, "query"));
  const limit = rowLimit(arguments_);
  const payload = await getJson(
    "/twitter/tweet/advanced_search",
    { query, queryType: SEARCH_QUERY_TYPE, ...cursorParams(arguments_) },
    options.apiKey,
    options,
  );
  return formatSearch(payload, { query, limit });
}

export async function userTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const user = screenName(argStr(arguments_, "user"));
  if (!user) {
    throw new TwitterApiIoError("user is required");
  }
  const params = isUserId(user) ? { userIds: user } : { userName: user };
  const path = isUserId(user) ? "/twitter/user/batch_info_by_ids" : "/twitter/user/info";
  const payload = await getJson(path, params, options.apiKey, options);
  if (isUserId(user)) {
    const users = asList(payload.users);
    if (!users.length) {
      return "no results";
    }
    return formatUser({ data: users[0] });
  }
  return formatUser(payload);
}

export async function postsTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const limit = rowLimit(arguments_);
  const payload = await getJson(
    "/twitter/user/last_tweets",
    { ...userParam(argStr(arguments_, "user")), ...cursorParams(arguments_) },
    options.apiKey,
    options,
  );
  return formatPosts(payload, { limit });
}

export async function postTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const tweetId = postId(argStr(arguments_, "id"));
  const payload = await getJson("/twitter/tweets", { tweet_ids: tweetId }, options.apiKey, options);
  return formatPost(payload);
}

export async function followersTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const limit = rowLimit(arguments_);
  const payload = await getJson(
    "/twitter/user/followers",
    { ...userNameParam(argStr(arguments_, "user")), pageSize: pageSize(arguments_), ...cursorParams(arguments_) },
    options.apiKey,
    options,
  );
  return formatUsers(payload, "followers", { limit });
}

export async function followingTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const limit = rowLimit(arguments_);
  const payload = await getJson(
    "/twitter/user/followings",
    { ...userNameParam(argStr(arguments_, "user")), pageSize: pageSize(arguments_), ...cursorParams(arguments_) },
    options.apiKey,
    options,
  );
  return formatUsers(payload, "followings", { limit });
}

export async function mentionsTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const limit = rowLimit(arguments_);
  const payload = await getJson(
    "/twitter/user/mentions",
    { ...userNameParam(argStr(arguments_, "user")), ...cursorParams(arguments_) },
    options.apiKey,
    options,
  );
  return formatPosts(payload, { limit });
}

export async function repliesTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const limit = rowLimit(arguments_);
  const payload = await getJson(
    "/twitter/tweet/replies",
    { tweetId: postId(argStr(arguments_, "id")), ...cursorParams(arguments_) },
    options.apiKey,
    options,
  );
  return formatPosts(payload, { limit });
}

export async function quotesTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const limit = rowLimit(arguments_);
  const payload = await getJson(
    "/twitter/tweet/quotes",
    { tweetId: postId(argStr(arguments_, "id")), ...cursorParams(arguments_) },
    options.apiKey,
    options,
  );
  return formatPosts(payload, { limit });
}

export async function trendsTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const limit = rowLimit(arguments_);
  const woeid = argStr(arguments_, "woeid") || WORLDWIDE_WOEID;
  if (!/^\d+$/.test(woeid)) {
    throw new TwitterApiIoError("woeid must be digits");
  }
  const payload = await getJson("/twitter/trends", { woeid, count: String(limit) }, options.apiKey, options);
  return formatTrends(payload, { limit });
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
  followers: followersTool,
  following: followingTool,
  mentions: mentionsTool,
  replies: repliesTool,
  quotes: quotesTool,
  trends: trendsTool,
};

export async function callTool(
  name: string,
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const handler = HANDLERS[name];
  if (!handler) {
    throw new TwitterApiIoError(`unknown TwitterAPI.io tool ${name}`);
  }
  return handler(arguments_, options);
}
