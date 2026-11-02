import { Type, type Static } from "@sinclair/typebox";

// The parameters of the Gmail tools, as the manifest lists them for each tool's input_schema.

const PageKey = Type.Optional(Type.String({ description: "Continue from a previous page_key." }));

/** `search_threads`: a Gmail search, one page of its threads. */
export const ThreadSearch = Type.Object({
  query: Type.String({ description: "Gmail search query. Operators such as from:user and is:unread work." }),
  limit: Type.Optional(Type.Integer({ description: "Threads this page. Default 15, max 30." })),
  page_key: PageKey,
});
export type ThreadSearch = Static<typeof ThreadSearch>;

/** `get_thread`: one thread by its id. */
export const ThreadLookup = Type.Object({
  thread_id: Type.String({ description: "Thread id from search_threads." }),
});

/** `get_message`: one message by its id. */
export const MessageLookup = Type.Object({
  message_id: Type.String({ description: "Message id from a thread or draft." }),
});

/** `download_attachment`: a message's attachment, by its part, and where in the workspace it is written. */
export const AttachmentDownload = Type.Object({
  message_id: Type.String({ description: "Message id, as get_thread lists it." }),
  part_id: Type.String({ description: "Attachment part id from get_message or get_thread." }),
  file_path: Type.Optional(
    Type.String({
      description: "Destination path in your home. Defaults to the attachment's filename in the workspace root.",
    }),
  ),
});
export type AttachmentDownload = Static<typeof AttachmentDownload>;

/** `list_labels`: no parameters. */
export const NoParameters = Type.Object({});

/** `list_drafts`: one page of the drafts. */
export const DraftPage = Type.Object({
  limit: Type.Optional(Type.Integer({ description: "Drafts this page. Default 15, max 30." })),
  page_key: PageKey,
});
export type DraftPage = Static<typeof DraftPage>;

/** `create_draft` and `send_message`: a plain-text message, its recipients, subject and body. */
export const OutgoingMessage = Type.Object({
  to: Type.String({ description: "Recipient address, or comma-separated addresses." }),
  subject: Type.String({ description: "Subject line." }),
  body: Type.String({ description: "Plain-text body." }),
  cc: Type.Optional(Type.String({ description: "Optional Cc addresses." })),
  bcc: Type.Optional(Type.String({ description: "Optional Bcc addresses." })),
});
export type OutgoingMessage = Static<typeof OutgoingMessage>;
