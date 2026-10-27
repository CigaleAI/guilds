import { Type, type Static, type TSchema } from "@sinclair/typebox";

// The TwitterAPI.io responses the tools read. Its endpoints name the same field differently
// (`userName`, `username`, `screen_name`), so a post, user or trend is an entry whose fields the
// tools read by their aliases. A list sits at the top of the body, as `data` itself, or under
// `data`; a field the tools print as it comes is `Shown`.

const Shown = Type.Optional(Type.Unknown());

function Nullable<T extends TSchema>(schema: T) {
  return Type.Optional(Type.Union([schema, Type.Null()]));
}

/** A post, user or trend, keyed by whichever field names its endpoint uses. */
export const Entry = Type.Record(Type.String(), Type.Unknown());
export type Entry = Static<typeof Entry>;

export const EntryList = Type.Array(Entry);

const Listed = Nullable(EntryList);

export const TwitterBody = Type.Object({
  data: Type.Optional(Type.Union([EntryList, Entry, Type.Null()])),
  tweets: Listed,
  users: Listed,
  followers: Listed,
  followings: Listed,
  trends: Listed,
  user: Shown,
  tweet: Shown,
  id: Shown,
  status: Shown,
  msg: Shown,
  message: Shown,
  error: Shown,
  has_next_page: Shown,
  next_cursor: Shown,
});
export type TwitterBody = Static<typeof TwitterBody>;

/** The lists a body can carry, at its top or under `data`. */
export type ListKey = "tweets" | "followers" | "followings" | "trends";

/** An error body: the message is text, or the first of a list of `{ msg }` entries. */
export const ErrorBody = Type.Object({ detail: Shown, msg: Shown, message: Shown, error: Shown });

export const ErrorList = Type.Array(Type.Unknown());

export const ErrorEntry = Type.Object({ msg: Shown, message: Shown });
