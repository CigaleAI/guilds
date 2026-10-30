import type { ArtifactFiles, FileView } from "./files.js";
import type { ArtifactActor, ArtifactLevel } from "./types.js";

/** A shared file that changed, for its guild's listeners: its display path. */
export type SharedFileChange = { displayPath: string };

/** What an operator's file writes run with: the shared files, and the announcement of each change. */
export type SharedFileWriteDeps = {
  files: ArtifactFiles;
  /** Tells the file's guild that it changed; absent on a box with no guild stream. */
  publishSharedFileChanged?: (guildId: string, change: SharedFileChange) => Promise<void>;
};

/** A file as an operator uploads it: the level it is stored at, its name, description, media type, and bytes. */
export type SharedFileUpload = {
  level: ArtifactLevel;
  name: string;
  description: string;
  mime: string;
  bytes: Buffer;
};

/** A file as an operator downloads it: its view, which names it and gives its media type, and its bytes. */
export type SharedFileDownload = { file: FileView; bytes: Buffer };

/** The file with this id and its current bytes, as `actor` reaches it. */
export async function readSharedFile(
  files: ArtifactFiles,
  actor: ArtifactActor,
  fileId: string,
): Promise<SharedFileDownload> {
  const row = await files.loadFileById(actor, fileId);
  return { file: files.view(row), bytes: await files.readBytes(row) };
}

/**
 * Stores the upload as `actor`'s file at its level, or a new version of the file of that name,
 * and announces it to the file's guild; an organisation's file has none.
 */
export async function uploadSharedFile(
  deps: SharedFileWriteDeps,
  actor: ArtifactActor,
  upload: SharedFileUpload,
): Promise<FileView> {
  const row = await deps.files.putFile(actor, upload);
  const view = deps.files.view(row);
  if (row.guild_id) {
    await deps.publishSharedFileChanged?.(row.guild_id, { displayPath: view.display_path });
  }
  return view;
}

/** Deletes the file with this id as `actor`, and announces it to the file's guild; an organisation's file has none. */
export async function deleteSharedFile(deps: SharedFileWriteDeps, actor: ArtifactActor, fileId: string): Promise<void> {
  const row = await deps.files.loadFileById(actor, fileId);
  await deps.files.deleteFile(actor, row);
  if (row.guild_id) {
    await deps.publishSharedFileChanged?.(row.guild_id, { displayPath: deps.files.view(row).display_path });
  }
}
