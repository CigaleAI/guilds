import { Type, type Static } from "typebox";

// The Tavily responses the search tool reads. Each object keeps the fields Tavily sends beyond the
// ones named.

/** A field Tavily sends as text, sends as null, or leaves out. */
const Text = Type.Optional(Type.Union([Type.String(), Type.Null()]));

export const SearchResponse = Type.Object({
  results: Type.Optional(Type.Array(Type.Object({ title: Text, url: Text, content: Text }))),
});
export type SearchResponse = Static<typeof SearchResponse>;

/** An error's detail one object deep: its message in `error` or `message`. */
export const ErrorDetail = Type.Object({ error: Text, message: Text });

/** Where an error body may carry its message: as text, or as an error detail. */
const ErrorField = Type.Optional(Type.Union([Type.String(), Type.Null(), ErrorDetail]));

/** An error body: the message sits in `detail`, `error` or `message`, as text or one object deeper. */
export const ErrorBody = Type.Object({ detail: ErrorField, error: ErrorField, message: ErrorField });
export type ErrorBody = Static<typeof ErrorBody>;
