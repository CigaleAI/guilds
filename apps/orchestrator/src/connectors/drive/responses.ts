import { Type, type Static } from "@sinclair/typebox";

// The Drive API responses the connector reads, and the parts of a remote Drive tool result it
// filters. Each object keeps the fields Drive sends beyond the ones named; Drive leaves out a
// field it has no value for, so every field is optional.

const Text = Type.Optional(Type.String());

/** A file or folder, with the fields the request asked for. */
export const DriveFile = Type.Object({
  id: Text,
  name: Text,
  mimeType: Text,
  parents: Type.Optional(Type.Array(Type.String())),
  driveId: Text,
  size: Text,
  description: Text,
  fileExtension: Text,
  webViewLink: Text,
  createdTime: Text,
  modifiedTime: Text,
  viewedByMeTime: Text,
  sharedWithMeTime: Text,
  owners: Type.Optional(Type.Array(Type.Object({ emailAddress: Text }))),
  capabilities: Type.Optional(Type.Object({ canAddChildren: Type.Optional(Type.Boolean()) })),
});
export type DriveFile = Static<typeof DriveFile>;

export const SharedDrive = Type.Object({ id: Text, name: Text });
export type SharedDrive = Static<typeof SharedDrive>;

export const FileList = Type.Object({
  files: Type.Optional(Type.Array(DriveFile)),
  nextPageToken: Text,
});
export type FileList = Static<typeof FileList>;

export const PermissionList = Type.Object({
  permissions: Type.Optional(
    Type.Array(Type.Object({ role: Text, displayName: Text, type: Text, emailAddress: Text })),
  ),
});
export type PermissionList = Static<typeof PermissionList>;

/** An error body: `error.message`, and the reason in `error.status`, `error.errors[0]` or `error.details`. */
export const ErrorBody = Type.Object({
  error: Type.Object({
    message: Type.Optional(Type.Unknown()),
    status: Type.Optional(Type.Unknown()),
    errors: Type.Optional(Type.Unknown()),
    details: Type.Optional(Type.Unknown()),
  }),
});

/** An entry of `errors` or `details` that names its reason. */
export const Reasoned = Type.Object({ reason: Type.String() });

/** Any JSON object: a remote tool result, its structured content, or a page of its listing. */
export const JsonObject = Type.Record(Type.String(), Type.Unknown());
export type JsonObject = Static<typeof JsonObject>;

/** A text part of a remote tool result's content. */
export const TextPart = Type.Object({ text: Type.String() });

/** A file a remote listing names: its id, and its parent under either spelling. */
export const ListedFile = Type.Object({
  id: Type.String(),
  parentId: Type.Optional(Type.Unknown()),
  parent_id: Type.Optional(Type.Unknown()),
});
