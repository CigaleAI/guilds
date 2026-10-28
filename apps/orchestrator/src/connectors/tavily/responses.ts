import { Type, type Static } from "@sinclair/typebox";

// The Tavily responses the search tool reads. Each object keeps the fields Tavily sends beyond the
// ones named; a field the tool prints only when it is text is `Shown`.

const Shown = Type.Optional(Type.Unknown());

export const SearchResponse = Type.Object({
  results: Type.Optional(Type.Array(Type.Object({ title: Shown, url: Shown, content: Shown }))),
});
export type SearchResponse = Static<typeof SearchResponse>;

/** An error body: the message sits in `detail`, `error` or `message`, as text or one object deeper. */
export const ErrorBody = Type.Object({ detail: Shown, error: Shown, message: Shown });

export const ErrorDetail = Type.Object({ error: Shown, message: Shown });
