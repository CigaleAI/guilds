import type { AccessRow } from "./access";

/**
 * Shapes of the orchestrator's JSON API for shared files, as the app reads them. Timestamps are
 * ISO-8601 in UTC.
 */

/** One of the organisation's shared files: its bytes live on the server, its row carries what it is. */
export type FileItem = {
  /** The file's id, which names it to the download, delete, and access API. */
  id: string;
  display_path: string;
  name: string;
  description: string;
  mime: string;
  bytes: number;
  version: number;
  author: string;
  updated_at: string;
  access?: "read" | "write";
};

/**
 * A file to store in the organisation: its bytes, what it is, and the row its access list starts
 * with when the upload creates it. A file of the same name is replaced and keeps its access list.
 */
export type FileUpload = { file: File; description: string; access: AccessRow };
