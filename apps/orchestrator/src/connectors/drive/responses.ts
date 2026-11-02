import { Type, type Static } from "typebox";

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

/** Who may reach a file, and how. */
export const Permission = Type.Object({ role: Text, displayName: Text, type: Text, emailAddress: Text });
export type Permission = Static<typeof Permission>;

export const PermissionList = Type.Object({ permissions: Type.Optional(Type.Array(Permission)) });
export type PermissionList = Static<typeof PermissionList>;

/** An entry of an error's `errors` or `details`, which may name the error's reason. */
const ErrorEntry = Type.Object({ reason: Text });

/** What went wrong: the message, and the reason in `status`, `errors[0]` or `details`. */
const GoogleError = Type.Object({
  message: Text,
  status: Text,
  errors: Type.Optional(Type.Array(ErrorEntry)),
  details: Type.Optional(Type.Array(ErrorEntry)),
});
export type GoogleError = Static<typeof GoogleError>;

/** An error body. */
export const ErrorBody = Type.Object({ error: GoogleError });
export type ErrorBody = Static<typeof ErrorBody>;

/** A remote tool result, or a part of one, given as text. */
export const ResultText = Type.String();

/** A text part of a remote tool result's content. */
export const TextPart = Type.Object({ text: Type.String() });

/** A file a remote listing names: its id, and its parent under either spelling. */
export const ListedFile = Type.Object({ id: Type.String(), parentId: Text, parent_id: Text });

/** The page token of a remote listing, under either spelling. */
export const ListingPage = Type.Object({ nextPageToken: Text, next_page_token: Text });
