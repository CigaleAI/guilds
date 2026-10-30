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
