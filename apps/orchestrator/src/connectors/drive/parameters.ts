import { Type, type Static } from "@sinclair/typebox";

// The arguments of the Drive tools the connector runs itself. Drive's listing offers
// `create_file` and `download_file_content` with the parameters declared here. It offers the
// other tools with the endpoint's own schema, whose arguments the connector reads under their
// camelCase and their snake_case spelling. Each object keeps the arguments it does not name.

const Text = Type.Optional(Type.String());
const Flag = Type.Optional(Type.Boolean());
const Count = Type.Optional(Type.Number());

/** The file a call acts on. */
const FILE = { fileId: Text, file_id: Text };

/** The file a call acts on and the folder it puts a file in. */
export const FileReference = Type.Object({ ...FILE, parentId: Text, parent_id: Text });
export type FileReference = Static<typeof FileReference>;

/** The arguments of a tool that acts on one file: `get_file_metadata`, `get_file_permissions`. */
export const FileParameters = Type.Object(FILE);
export type FileArguments = Static<typeof FileParameters>;

/** A page of a listing: how many files it holds, and the token of the page to read. */
const PAGE = { pageSize: Count, page_size: Count, pageToken: Text, page_token: Text };

/** `search_files`: the query, in the Drive MCP's terms, and the page. */
export const SearchFilesParameters = Type.Object({ query: Text, ...PAGE });
export type SearchFilesArguments = Static<typeof SearchFilesParameters>;

/** `list_recent_files`: the order, and the page. */
export const ListRecentFilesParameters = Type.Object({ orderBy: Text, order_by: Text, ...PAGE });
export type ListRecentFilesArguments = Static<typeof ListRecentFilesParameters>;

/** `read_file_content`: the file, and whether the call asks for its comments. */
export const ReadFileParameters = Type.Object({ ...FILE, includeComments: Flag, include_comments: Flag });
export type ReadFileArguments = Static<typeof ReadFileParameters>;

/** `copy_file`: the file, the copy's title, and the folder the copy goes in. */
export const CopyFileParameters = Type.Object({ ...FileReference.properties, title: Text });
export type CopyFileArguments = Static<typeof CopyFileParameters>;

/** `download_file_content`: the file, the workspace path to write it to, and the type to export a Google file to. */
export const DownloadFileParameters = Type.Object({
  fileId: Type.String({ description: "Drive file id." }),
  file_path: Type.Optional(
    Type.String({ description: "Destination path in your home. Defaults to the file's title in the workspace root." }),
  ),
  exportMimeType: Type.Optional(
    Type.String({ description: "For Google Docs, Sheets, or Slides, the MIME type to export to." }),
  ),
});
export type DownloadFileArguments = Static<typeof DownloadFileParameters>;

/** `create_file`: the name, the content as a workspace path or as text, its type, and the parent folder. */
export const CreateFileParameters = Type.Object({
  title: Type.Optional(Type.String({ description: "File or folder name." })),
  file_path: Type.Optional(
    Type.String({ description: "Path in your home. The orchestrator reads this file. Do not pass file bytes." }),
  ),
  textContent: Type.Optional(
    Type.String({ description: "UTF-8 text for a small file. Use file_path for large or binary files." }),
  ),
  contentMimeType: Type.Optional(
    Type.String({
      description:
        "MIME type of the content. Inferred from file_path when omitted. Use application/vnd.google-apps.folder to create a folder.",
    }),
  ),
  parentId: Type.Optional(Type.String({ description: "Parent folder id. Defaults to the connected folder." })),
  disableConversionToGoogleType: Type.Optional(
    Type.Boolean({ description: "Keep the given MIME type instead of converting to a Google type." }),
  ),
});
export type CreateFileArguments = Static<typeof CreateFileParameters>;
