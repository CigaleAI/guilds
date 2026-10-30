/**
 * Shapes of the orchestrator's JSON API for shared files, as the app reads them. Timestamps are
 * ISO-8601 in UTC.
 */

/** A shared file in a files scope: its bytes live on the server, its row carries what it is. */
export type FileItem = {
  /** The file's id, which names it to the download, delete, and access API. */
  id: string;
  display_path: string;
  name: string;
  description: string;
  mime: string;
  bytes: number;
  level: "agent" | "guild" | "org";
  owner_id: string;
  version: number;
  author: string;
  updated_at: string;
  access?: "read" | "write";
};

/** A file to store under a files scope, with what it is. */
export type FileUpload = { file: File; description: string };
