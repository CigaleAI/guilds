import { Type, type Static, type TSchema } from "@sinclair/typebox";

// The Gmail responses the tools read. Each object keeps the fields Gmail sends beyond the ones
// named; a field the tools print, or read only when it has the type they expect, is `Shown`.

const Shown = Type.Optional(Type.Unknown());

function Nullable<T extends TSchema>(schema: T) {
  return Type.Optional(Type.Union([schema, Type.Null()]));
}

export const Header = Type.Object({ name: Shown, value: Shown });
export type Header = Static<typeof Header>;

/** A message part: text, an attachment, or a container of parts. */
export const MessagePart = Type.Recursive((Part) =>
  Type.Object({
    partId: Shown,
    mimeType: Shown,
    filename: Shown,
    headers: Nullable(Type.Array(Header)),
    body: Nullable(Type.Object({ data: Shown, size: Shown, attachmentId: Shown })),
    parts: Nullable(Type.Array(Part)),
  }),
);
export type MessagePart = Static<typeof MessagePart>;

export const Message = Type.Object({ id: Shown, threadId: Shown, snippet: Shown, payload: Nullable(MessagePart) });
export type Message = Static<typeof Message>;

export const ProfileResponse = Type.Object({ emailAddress: Shown });

/** A thread as a listing names it: its id and a snippet. */
export const ThreadSummary = Type.Object({ id: Shown, snippet: Shown });
export type ThreadSummary = Static<typeof ThreadSummary>;

export const ThreadListResponse = Type.Object({
  threads: Nullable(Type.Array(ThreadSummary)),
  resultSizeEstimate: Shown,
  nextPageToken: Shown,
});

export const ThreadResponse = Type.Object({ id: Shown, messages: Nullable(Type.Array(Message)) });

export const AttachmentResponse = Type.Object({ data: Shown, size: Shown });

export const LabelsResponse = Type.Object({
  labels: Nullable(Type.Array(Type.Object({ id: Shown, name: Shown, type: Shown }))),
});

/** A draft as a listing names it: its id. */
export const DraftSummary = Type.Object({ id: Shown });
export type DraftSummary = Static<typeof DraftSummary>;

export const DraftListResponse = Type.Object({
  drafts: Nullable(Type.Array(DraftSummary)),
  nextPageToken: Shown,
});

export const DraftResponse = Type.Object({ id: Shown, message: Nullable(Message) });

export const SentResponse = Type.Object({ id: Shown, threadId: Shown });

/** An error body: the message sits in `error.message`. */
export const ErrorBody = Type.Object({ error: Type.Object({ message: Shown }) });
