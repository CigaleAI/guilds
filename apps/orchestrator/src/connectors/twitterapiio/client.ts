import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { proxyFetch, withQuery, type FetchFn } from "../../net/http.js";
import { decodeResponse, type ConnectorApi } from "../response.js";
import { LIST_DEFAULT, clipRows, clipText, fmtNum, joinParts } from "../format.js";
import type { ApiGet } from "../types.js";
import {
  AccountResponse,
  ErrorBody,
  FailedBody,
  FollowersResponse,
  FollowingsResponse,
  TimelineResponse,
  TrendsResponse,
  TweetsResponse,
  UserInfoResponse,
  UsersResponse,
  type Paging,
  type Trend,
  type Tweet,
  type UserInfo,
  type UserProfile,
} from "./responses.js";

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

/** The page of a list a call asks for: how many rows it shows, and the cursor of the page to start at. */
export type ListPage = { rows: number; cursor: string | undefined };

/** A user as a row shows them, from either shape TwitterAPI.io sends a user in. */
type UserFacts = {
  id: string | undefined;
  userName: string | undefined;
  name: string | undefined;
  /** The verification mark: the kind of verification, or `verified`; null when unverified. */
  mark: string | null;
  followers: number | undefined;
  following: number | undefined;
  posts: number | undefined;
  createdAt: string | undefined;
};

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

/** Text, trimmed; null when it is blank or absent. */
function text(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** A username without its leading `@`s. */
function screenName(value: string): string {
  return value.trim().replace(/^@+/, "");
}

function handle(userName: string | undefined): string {
  const name = screenName(userName ?? "");
  return name ? `@${name}` : "";
}

/** What a row shows of a user info. */
function infoFacts(user: UserInfo): UserFacts {
  return {
    id: user.id,
    userName: user.userName,
    name: user.name,
    mark: user.isBlueVerified === true ? (text(user.verifiedType) ?? "verified") : null,
    followers: user.followers,
    following: user.following,
    posts: user.statusesCount,
    createdAt: user.createdAt,
  };
}

/** What a row shows of a listed profile. */
function profileFacts(user: UserProfile): UserFacts {
  return {
    id: user.id,
    userName: user.userName ?? user.screen_name,
    name: user.name,
    mark: user.isBlueVerified === true || user.verified === true ? "verified" : null,
    followers: user.followers_count,
    following: user.friends_count ?? user.following_count,
    posts: user.statuses_count,
    createdAt: user.created_at,
  };
}

function userRow(user: UserFacts): string {
  return joinParts(
    user.id,
    handle(user.userName),
    user.name,
    user.mark,
    `followers=${fmtNum(user.followers)}`,
    `following=${fmtNum(user.following)}`,
    `posts=${fmtNum(user.posts)}`,
    user.createdAt,
  );
}

function postRow(item: Tweet): string {
  const author = item.author;
  return joinParts(
    item.id,
    handle(author?.userName),
    author?.name,
    item.createdAt,
    `likes=${fmtNum(item.likeCount)}`,
    `rts=${fmtNum(item.retweetCount)}`,
    `replies=${fmtNum(item.replyCount)}`,
    `quotes=${fmtNum(item.quoteCount)}`,
    clipText(item.text, TEXT_CAP),
  );
}

/** The rows, with the page key of the next page when there is one. */
function withPage(body: string, paging: Paging): string {
  if (body === "no results" || paging.has_next_page === false) {
    return body;
  }
  const token = text(paging.next_cursor);
  return token ? `${body}\npage=${token}` : body;
}

export function formatUser(user: UserInfo | null | undefined): string {
  if (!user || (!user.id && !user.userName)) {
    return "no results";
  }
  const head = userRow(infoFacts(user));
  const bio = clipText(user.description, TEXT_CAP);
  return [head, bio].filter(Boolean).join("\n") || "no results";
}

export function formatPosts(tweets: readonly Tweet[], paging: Paging, limit = LIST_DEFAULT): string {
  return withPage(clipRows(tweets.map(postRow).filter(Boolean), limit), paging);
}

export function formatSearch(page: TweetsResponse, query: string, limit = LIST_DEFAULT): string {
  const tweets = page.tweets ?? [];
  const body = formatPosts(tweets, page, limit);
  if (body === "no results") {
    return body;
  }
  return [joinParts(query, `n=${fmtNum(tweets.length)}`), body].join("\n");
}

export function formatPost(item: Tweet | undefined): string {
  if (!item) {
    return "no results";
  }
  const row = postRow(item);
  const conversation = text(item.conversationId);
  const extra = conversation && conversation !== text(item.id) ? `conversation=${conversation}` : "";
  return [row, extra].filter(Boolean).join("\n") || "no results";
}

export function formatUsers(users: readonly UserProfile[], paging: Paging, limit = LIST_DEFAULT): string {
  const rows = users.map((user) => userRow(profileFacts(user))).filter(Boolean);
  return withPage(clipRows(rows, limit), paging);
}

export function formatTrends(trends: readonly Trend[], limit = LIST_DEFAULT): string {
  const rows = trends.flatMap(({ trend }) =>
    trend?.name ? [joinParts(trend.name, `rank=${fmtNum(trend.rank)}`)] : [],
  );
  return clipRows(rows, limit);
}

/** The message of an error body: its text, or the first entry's of its list. */
function errorMessage(body: ErrorBody): string | null {
  const detail = body.detail;
  if (Array.isArray(detail)) {
    return text(detail[0]?.msg ?? detail[0]?.message);
  }
  return text(detail ?? body.msg ?? body.message);
}

/** TwitterAPI.io's API as the client reads its responses. */
const TWITTERAPIIO: ConnectorApi<typeof ErrorBody> = {
  name: "TwitterAPI.io",
  error: (message, status) => new TwitterApiIoError(message, status),
  errorBody: ErrorBody,
  errorMessage,
};

type TwitterApiIoOptions = { client?: FetchFn; proxyUrl?: string };

type ToolOptions = TwitterApiIoOptions & { apiKey: string };

/** The response at the request's path with its query, as its schema describes it; a body whose status is an error throws. */
async function getJson<T extends TSchema>(
  request: ApiGet<T>,
  apiKey: string,
  options: TwitterApiIoOptions = {},
): Promise<Static<T>> {
  const key = apiKey.trim();
  if (!key) {
    throw new TwitterApiIoError("TwitterAPI.io API key is missing", 401);
  }
  const fetchFn = options.client ?? proxyFetch(options.proxyUrl ?? "");
  const response = await fetchFn(withQuery(`${API_BASE}${request.path}`, request.params), {
    method: "GET",
    headers: { "x-api-key": key, Accept: "application/json" },
  });
  const payload = await decodeResponse(TWITTERAPIIO, response, request.schema);
  if (Value.Check(FailedBody, payload)) {
    throw new TwitterApiIoError(text(payload.msg) ?? "TwitterAPI.io returned an error");
  }
  return payload;
}

/** The username a call names, without its `@`; refused when it is blank. */
function requiredUser(value: string): string {
  const name = screenName(value);
  if (!name) {
    throw new TwitterApiIoError("user is required");
  }
  return name;
}

/** The query naming a user by id or by username. */
function userQuery(value: string) {
  const name = requiredUser(value);
  return isUserId(name) ? { userId: name } : { userName: name };
}

/** The query of the page a call starts at. */
function cursorQuery(page: ListPage) {
  return page.cursor ? { cursor: page.cursor } : {};
}

/** The rows a followers or followings page asks TwitterAPI.io for. */
function pageSize(page: ListPage): string {
  return String(Math.max(20, Math.min(200, page.rows)));
}

export function constrainSearchQuery(query: string): string {
  const stripped = query.replace(SEARCH_TIME_OPERATOR, " ").replace(/\s+/g, " ").trim();
  if (!stripped) {
    throw new TwitterApiIoError("query is required");
  }
  return `${stripped} ${SEARCH_WINDOW}`;
}

export async function ping(apiKey: string, options: TwitterApiIoOptions = {}): Promise<void> {
  await getJson({ path: "/oapi/my/info", params: {}, schema: AccountResponse }, apiKey, options);
}

/** Top posts of the last 24 hours matching `query`. */
export async function search(query: string, page: ListPage, options: ToolOptions): Promise<string> {
  const constrained = constrainSearchQuery(query);
  const params = { query: constrained, queryType: SEARCH_QUERY_TYPE, ...cursorQuery(page) };
  const payload = await getJson(
    { path: "/twitter/tweet/advanced_search", params, schema: TweetsResponse },
    options.apiKey,
    options,
  );
  return formatSearch(payload, constrained, page.rows);
}

/** One profile, by username or user id. */
export async function user(value: string, options: ToolOptions): Promise<string> {
  const name = requiredUser(value);
  if (isUserId(name)) {
    const payload = await getJson(
      { path: "/twitter/user/batch_info_by_ids", params: { userIds: name }, schema: UsersResponse },
      options.apiKey,
      options,
    );
    return formatUser(payload.users?.[0]);
  }
  const payload = await getJson(
    { path: "/twitter/user/info", params: { userName: name }, schema: UserInfoResponse },
    options.apiKey,
    options,
  );
  return formatUser(payload.data);
}

/** The last posts of one account, by username or user id. */
export async function posts(value: string, page: ListPage, options: ToolOptions): Promise<string> {
  const payload = await getJson(
    {
      path: "/twitter/user/last_tweets",
      params: { ...userQuery(value), ...cursorQuery(page) },
      schema: TimelineResponse,
    },
    options.apiKey,
    options,
  );
  return formatPosts(payload.data?.tweets ?? [], payload, page.rows);
}

/** One post, by id or status URL. */
export async function post(value: string, options: ToolOptions): Promise<string> {
  const payload = await getJson(
    { path: "/twitter/tweets", params: { tweet_ids: postId(value) }, schema: TweetsResponse },
    options.apiKey,
    options,
  );
  return formatPost(payload.tweets?.[0]);
}

/** The accounts following one user. */
export async function followers(value: string, page: ListPage, options: ToolOptions): Promise<string> {
  const payload = await getJson(
    {
      path: "/twitter/user/followers",
      params: { userName: requiredUser(value), pageSize: pageSize(page), ...cursorQuery(page) },
      schema: FollowersResponse,
    },
    options.apiKey,
    options,
  );
  return formatUsers(payload.followers ?? [], payload, page.rows);
}

/** The accounts one user follows. */
export async function following(value: string, page: ListPage, options: ToolOptions): Promise<string> {
  const payload = await getJson(
    {
      path: "/twitter/user/followings",
      params: { userName: requiredUser(value), pageSize: pageSize(page), ...cursorQuery(page) },
      schema: FollowingsResponse,
    },
    options.apiKey,
    options,
  );
  return formatUsers(payload.followings ?? [], payload, page.rows);
}

/** Posts that mention one user. */
export async function mentions(value: string, page: ListPage, options: ToolOptions): Promise<string> {
  const payload = await getJson(
    {
      path: "/twitter/user/mentions",
      params: { userName: requiredUser(value), ...cursorQuery(page) },
      schema: TweetsResponse,
    },
    options.apiKey,
    options,
  );
  return formatPosts(payload.tweets ?? [], payload, page.rows);
}

/** The posts a post's list at `path` holds: its replies or its quotes. */
async function postList(path: string, value: string, page: ListPage, options: ToolOptions): Promise<string> {
  const payload = await getJson(
    { path, params: { tweetId: postId(value), ...cursorQuery(page) }, schema: TweetsResponse },
    options.apiKey,
    options,
  );
  return formatPosts(payload.tweets ?? [], payload, page.rows);
}

/** The replies under one post. */
export async function replies(value: string, page: ListPage, options: ToolOptions): Promise<string> {
  return postList("/twitter/tweet/replies", value, page, options);
}

/** The quote posts of one post. */
export async function quotes(value: string, page: ListPage, options: ToolOptions): Promise<string> {
  return postList("/twitter/tweet/quotes", value, page, options);
}

/** The trending topics at a Yahoo WOEID; worldwide when it is absent. */
export async function trends(woeid: string | undefined, rows: number, options: ToolOptions): Promise<string> {
  const place = woeid?.trim() || WORLDWIDE_WOEID;
  if (!/^\d+$/.test(place)) {
    throw new TwitterApiIoError("woeid must be digits");
  }
  const payload = await getJson(
    { path: "/twitter/trends", params: { woeid: place, count: String(rows) }, schema: TrendsResponse },
    options.apiKey,
    options,
  );
  return formatTrends(payload.trends ?? [], rows);
}
