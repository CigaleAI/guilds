import { Type, type Static, type TSchema } from "@sinclair/typebox";

// The X API responses the tools read. Each object keeps the fields X sends beyond the ones named;
// a field the tools print as it comes is `Shown`.

const Shown = Type.Optional(Type.Unknown());

function Nullable<T extends TSchema>(schema: T) {
  return Type.Optional(Type.Union([schema, Type.Null()]));
}

/** `data` holds one item or a list of them, depending on the endpoint. */
function DataOf<T extends TSchema>(item: T) {
  return Type.Optional(Type.Union([Type.Array(item), item, Type.Null()]));
}

export const XUser = Type.Object({
  id: Shown,
  username: Shown,
  name: Shown,
  created_at: Shown,
  description: Shown,
  verified: Shown,
  verified_type: Shown,
  public_metrics: Nullable(Type.Object({ followers_count: Shown, following_count: Shown, tweet_count: Shown })),
});
export type XUser = Static<typeof XUser>;

export const XPost = Type.Object({
  id: Shown,
  author_id: Shown,
  created_at: Shown,
  text: Shown,
  conversation_id: Shown,
  note_tweet: Nullable(Type.Object({ text: Shown })),
  public_metrics: Nullable(
    Type.Object({ like_count: Shown, retweet_count: Shown, reply_count: Shown, quote_count: Shown }),
  ),
});
export type XPost = Static<typeof XPost>;

export const UserResponse = Type.Object({ data: DataOf(XUser) });
export type UserResponse = Static<typeof UserResponse>;

/** A post or a page of posts, with the users they name and the paging token. */
export const PostsResponse = Type.Object({
  data: DataOf(XPost),
  includes: Nullable(Type.Object({ users: Type.Optional(Type.Array(XUser)) })),
  meta: Nullable(Type.Object({ next_token: Shown, result_count: Shown })),
});
export type PostsResponse = Static<typeof PostsResponse>;

/** An error body: the first of `errors`, else `detail`, `title` or `error`. */
export const ErrorBody = Type.Object({ errors: Shown, detail: Shown, title: Shown, error: Shown });

export const ErrorList = Type.Array(Type.Unknown());

export const ErrorEntry = Type.Object({ message: Shown, detail: Shown, title: Shown });
