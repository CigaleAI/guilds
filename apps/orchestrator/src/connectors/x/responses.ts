import { Type, type Static, type TSchema } from "@sinclair/typebox";

// The X API v2 responses the tools read. Each object keeps the fields X sends beyond the ones named.

/** A field X sends as text, or leaves out. */
const Text = Type.Optional(Type.String());

/** A count X sends as a number, or leaves out. */
const Count = Type.Optional(Type.Number());

function Nullable<T extends TSchema>(schema: T) {
  return Type.Optional(Type.Union([schema, Type.Null()]));
}

/** A user, with the `user.fields` the client asks for: X always sends its id, username and name. */
export const XUser = Type.Object({
  id: Type.String(),
  username: Type.String(),
  name: Type.String(),
  created_at: Text,
  description: Text,
  verified: Type.Optional(Type.Boolean()),
  verified_type: Text,
  public_metrics: Nullable(Type.Object({ followers_count: Count, following_count: Count, tweet_count: Count })),
});
export type XUser = Static<typeof XUser>;

/** A post, with the `tweet.fields` the client asks for: X always sends its id and text. */
export const XPost = Type.Object({
  id: Type.String(),
  text: Type.String(),
  author_id: Text,
  created_at: Text,
  conversation_id: Text,
  note_tweet: Nullable(Type.Object({ text: Text })),
  public_metrics: Nullable(
    Type.Object({ like_count: Count, retweet_count: Count, reply_count: Count, quote_count: Count }),
  ),
});
export type XPost = Static<typeof XPost>;

/** The users a response's posts name, expanded from their `author_id`. */
const Includes = Nullable(Type.Object({ users: Type.Optional(Type.Array(XUser)) }));

/** One user; X leaves `data` out when it finds none and says why in `errors`. */
export const UserResponse = Type.Object({ data: Type.Optional(XUser) });
export type UserResponse = Static<typeof UserResponse>;

/** One post, with the user it names; X leaves `data` out when it finds none. */
export const PostResponse = Type.Object({ data: Type.Optional(XPost), includes: Includes });
export type PostResponse = Static<typeof PostResponse>;

/** A page of posts, with the users they name, the page's size and the token of the next page. */
export const PostsResponse = Type.Object({
  data: Type.Optional(Type.Array(XPost)),
  includes: Includes,
  meta: Nullable(Type.Object({ next_token: Text, result_count: Count })),
});
export type PostsResponse = Static<typeof PostsResponse>;

/** One of the errors an error body lists. */
const ErrorEntry = Type.Object({ message: Text, detail: Text, title: Text });

/** An error body: the first of `errors`, else `detail`, `title` or `error`. */
export const ErrorBody = Type.Object({
  errors: Type.Optional(Type.Array(ErrorEntry)),
  detail: Text,
  title: Text,
  error: Text,
});
export type ErrorBody = Static<typeof ErrorBody>;
