import { Type, type Static, type TSchema } from "typebox";

// The TwitterAPI.io responses the tools read. Each object keeps the fields TwitterAPI.io sends
// beyond the ones named. A user comes in two shapes: the camelCase user info of a profile, a
// batch and a post's author, and the snake_case profile of a followers or followings list.

/** A field TwitterAPI.io sends as text, or leaves out. */
const Text = Type.Optional(Type.String());

/** A count TwitterAPI.io sends as a number, or leaves out. */
const Count = Type.Optional(Type.Number());

/** A flag TwitterAPI.io sends as a boolean, or leaves out. */
const Flag = Type.Optional(Type.Boolean());

function Nullable<T extends TSchema>(schema: T) {
  return Type.Optional(Type.Union([schema, Type.Null()]));
}

/** A user as a profile, a batch and a post's author carry it. An unavailable account has no id or name. */
export const UserInfo = Type.Object({
  id: Text,
  userName: Text,
  name: Text,
  isBlueVerified: Flag,
  verifiedType: Text,
  createdAt: Text,
  description: Text,
  followers: Count,
  following: Count,
  statusesCount: Count,
});
export type UserInfo = Static<typeof UserInfo>;

/** A user as a followers or followings list carries it. */
export const UserProfile = Type.Object({
  id: Text,
  userName: Text,
  screen_name: Text,
  name: Text,
  verified: Flag,
  isBlueVerified: Flag,
  created_at: Text,
  followers_count: Count,
  following_count: Count,
  friends_count: Count,
  statuses_count: Count,
});
export type UserProfile = Static<typeof UserProfile>;

/** A post, with the author it names. */
export const Tweet = Type.Object({
  id: Text,
  text: Text,
  createdAt: Text,
  conversationId: Text,
  likeCount: Count,
  retweetCount: Count,
  replyCount: Count,
  quoteCount: Count,
  author: Type.Optional(UserInfo),
});
export type Tweet = Static<typeof Tweet>;

/** A trending topic, ranked from 1. */
export const Trend = Type.Object({
  trend: Type.Optional(Type.Object({ name: Text, rank: Count })),
});
export type Trend = Static<typeof Trend>;

/** Where a list goes on: whether there is a next page, and the cursor that fetches it. */
const PAGING = { has_next_page: Flag, next_cursor: Text };
export const Paging = Type.Object(PAGING);
export type Paging = Static<typeof Paging>;

/** A body whose status says the call failed though the response did not, with the message it gives. */
export const FailedBody = Type.Object({ status: Type.Literal("error"), msg: Text });

/** The account the key belongs to; the check of a key reads only its status. */
export const AccountResponse = Type.Object({});

/** Posts: a search, a user's mentions, a post's replies or quotes, posts by id. */
export const TweetsResponse = Type.Object({ tweets: Type.Optional(Type.Array(Tweet)), ...PAGING });
export type TweetsResponse = Static<typeof TweetsResponse>;

/** A user's last posts, under `data`; `data` is null when the user is not found. */
export const TimelineResponse = Type.Object({
  data: Nullable(Type.Object({ tweets: Type.Optional(Type.Array(Tweet)) })),
  ...PAGING,
});
export type TimelineResponse = Static<typeof TimelineResponse>;

/** One user by username; `data` is null when the user is not found. */
export const UserInfoResponse = Type.Object({ data: Nullable(UserInfo) });
export type UserInfoResponse = Static<typeof UserInfoResponse>;

/** Users by id. */
export const UsersResponse = Type.Object({ users: Type.Optional(Type.Array(UserInfo)) });
export type UsersResponse = Static<typeof UsersResponse>;

export const FollowersResponse = Type.Object({ followers: Type.Optional(Type.Array(UserProfile)), ...PAGING });
export type FollowersResponse = Static<typeof FollowersResponse>;

export const FollowingsResponse = Type.Object({ followings: Type.Optional(Type.Array(UserProfile)), ...PAGING });
export type FollowingsResponse = Static<typeof FollowingsResponse>;

export const TrendsResponse = Type.Object({ trends: Type.Optional(Type.Array(Trend)) });
export type TrendsResponse = Static<typeof TrendsResponse>;

/** One of the entries an error body lists. */
const ErrorEntry = Type.Object({ msg: Text, message: Text });

/** An error body: the message is in `detail`, as text or the first of a list of entries, or in `msg` or `message`. */
export const ErrorBody = Type.Object({
  detail: Type.Optional(Type.Union([Type.String(), Type.Array(ErrorEntry)])),
  msg: Text,
  message: Text,
});
export type ErrorBody = Static<typeof ErrorBody>;
