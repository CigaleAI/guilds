import { loadOperatorActor } from "./actors.js";
import type { ArtifactFiles, FileView } from "./files.js";
import type { ArtifactActor, ArtifactLevel } from "./types.js";
import type { AgentRow } from "../db/agents.js";
import type { GuildRow } from "../db/guilds.js";
import type { Queryable } from "../db/pg.js";
import type { UserRow } from "../db/users.js";

/** Whose shared files an operator reaches: an agent or a guild they see, or their organisation. */
export type SharedFileOwner =
  | { level: "agent"; agent: AgentRow }
  | { level: "guild"; guild: GuildRow }
  | { level: "org"; orgId: string };

/** What an operator's file lists run with: the database their actor is loaded from, and the shared files. */
export type SharedFileReadDeps = { db: Queryable; files: ArtifactFiles };

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

/** The user as the artifact actor of the owner's scope, with the private guilds they do not operate hidden from them. */
export async function loadSharedFileActor(
  db: Queryable,
  owner: SharedFileOwner,
  user: UserRow,
): Promise<ArtifactActor> {
  if (owner.level === "agent") {
    const { agent } = owner;
    return loadOperatorActor(db, user, { orgId: agent.org_id, guildId: agent.guild_id, agentId: agent.id });
  }
  if (owner.level === "guild") {
    return loadOperatorActor(db, user, { orgId: owner.guild.org_id, guildId: owner.guild.id });
  }
  return loadOperatorActor(db, user, { orgId: owner.orgId });
}

/** The id of the agent, guild, or organisation that holds the owner's files. */
function sharedFileOwnerId(owner: SharedFileOwner): string {
  if (owner.level === "agent") {
    return owner.agent.id;
  }
  if (owner.level === "guild") {
    return owner.guild.id;
  }
  return owner.orgId;
}

/** The files the owner holds that `user` may read, by name. */
export async function listSharedFiles(
  deps: SharedFileReadDeps,
  owner: SharedFileOwner,
  user: UserRow,
): Promise<FileView[]> {
  const actor = await loadSharedFileActor(deps.db, owner, user);
  return await deps.files.listOwnerFiles(actor, owner.level, sharedFileOwnerId(owner));
}

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
