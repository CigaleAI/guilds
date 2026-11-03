import type { AccessRow, ListedItem } from "./access";

/**
 * Shapes of the orchestrator's JSON API for shared files, as the app reads them. Timestamps are
 * ISO-8601 in UTC.
 */

/** One of the organisation's shared files: its bytes live on the server, its row carries what it is. */
export type StoredFile = {
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

/** A shared file as a guild's or an agent's files list holds it. */
export type FileItem = StoredFile & ListedItem;

/**
 * A file to store in the organisation: its bytes, what it is; when the upload creates it, the row
 * its access list starts with and the guild it is homed in (without one, the organisation); and the
 * version the uploader expects: 0 when no file may have its name yet, the version it read of the
 * file it replaces otherwise. The server refuses (409) an upload whose version does not match;
 * without one, a file of the same name is replaced unchecked. A replaced file keeps its access list
 * and its home.
 */
export type FileUpload = {
  file: File;
  description: string;
  access: AccessRow;
  homeGuildId?: string;
  expectedVersion?: number;
};
