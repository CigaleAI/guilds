import { Type, type Static } from "@sinclair/typebox";

// The Gmail responses the tools read, each field as Gmail sends it. Gmail leaves out a field it
// has no value for rather than send null; each object keeps the fields Gmail sends beyond the
// ones named.

const Text = Type.Optional(Type.String());

export const Header = Type.Object({ name: Text, value: Text });
export type Header = Static<typeof Header>;

/** A part's body: its bytes inline in `data` as base64url, or fetched by `attachmentId`, and their count. */
const PartBody = Type.Object({ data: Text, size: Type.Optional(Type.Number()), attachmentId: Text });

/** A message part: text, an attachment, or a container of parts. */
export const MessagePart = Type.Recursive((Part) =>
  Type.Object({
    partId: Text,
    mimeType: Text,
    filename: Text,
    headers: Type.Optional(Type.Array(Header)),
    body: Type.Optional(PartBody),
    parts: Type.Optional(Type.Array(Part)),
  }),
);
export type MessagePart = Static<typeof MessagePart>;

export const Message = Type.Object({ id: Text, threadId: Text, snippet: Text, payload: Type.Optional(MessagePart) });
export type Message = Static<typeof Message>;

export const ProfileResponse = Type.Object({ emailAddress: Text });

/** A thread as a listing names it: its id and a snippet. */
export const ThreadSummary = Type.Object({ id: Text, snippet: Text });
export type ThreadSummary = Static<typeof ThreadSummary>;

export const ThreadListResponse = Type.Object({
  threads: Type.Optional(Type.Array(ThreadSummary)),
  resultSizeEstimate: Type.Optional(Type.Number()),
  nextPageToken: Text,
});

export const ThreadResponse = Type.Object({ id: Text, messages: Type.Optional(Type.Array(Message)) });

export const AttachmentResponse = Type.Object({ data: Text, size: Type.Optional(Type.Number()) });

export const LabelsResponse = Type.Object({
  labels: Type.Optional(Type.Array(Type.Object({ id: Text, name: Text, type: Text }))),
});

/** A draft as a listing names it: its id. */
export const DraftSummary = Type.Object({ id: Text });
export type DraftSummary = Static<typeof DraftSummary>;

export const DraftListResponse = Type.Object({
  drafts: Type.Optional(Type.Array(DraftSummary)),
  nextPageToken: Text,
});

export const DraftResponse = Type.Object({ id: Text, message: Type.Optional(Message) });

export const SentResponse = Type.Object({ id: Text, threadId: Text });

/** An error body: the message sits in `error.message`. */
export const ErrorBody = Type.Object({ error: Type.Object({ message: Text }) });
export type ErrorBody = Static<typeof ErrorBody>;
