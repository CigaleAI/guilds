import { creatorGrant, parseGrant, type SubjectEntry } from "./access.js";
import { guildsOnList } from "./access-lists.js";
import { loadOperatorActor } from "./actors.js";
import type { ArtifactFiles, FileView } from "./files.js";
import type { ArtifactStore } from "./store.js";
import type { ArtifactActor } from "./types.js";
import type { AgentRow } from "../db/agents.js";
import type { GuildRow } from "../db/guilds.js";
import type { Queryable } from "../db/pg.js";
import type { UserRow } from "../db/users.js";

/**
 * The page whose files a listing shows: the organisation's lists every file, a guild's the files
 * whose access list has a row for the guild, one of its agents, or the organisation, an agent's the
 * files it reads.
 */
export type FilesPage =
  | { scope: "agent"; agent: AgentRow }
  | { scope: "guild"; guild: GuildRow }
  | { scope: "org"; orgId: string };

/** What an operator's file lists run with: the database their actor is loaded from, and the shared files. */
export type SharedFileReadDeps = { db: Queryable; files: ArtifactFiles };

/** A shared file that changed, for its guilds' listeners: its display path. */
export type SharedFileChange = { displayPath: string };

/** What an operator's file writes run with: the artifact store its access lists are read from, the shared files, and the announcement of each change. */
export type SharedFileWriteDeps = {
  artifacts: ArtifactStore;
  files: ArtifactFiles;
  /** Tells a guild that one of its files changed; absent on a box with no guild stream. */
  publishSharedFileChanged?: (guildId: string, change: SharedFileChange) => Promise<void>;
};

/**
 * A file as an operator uploads it: its name, description, media type, and bytes, the version they
 * replace when they say (0 for a file that must not exist yet), and the subject and mode of the row
 * its access list starts with when the upload creates it; without one, the organisation writes it.
 */
export type SharedFileUpload = {
  name: string;
  description: string;
  mime: string;
  bytes: Buffer;
  expectedVersion: number | undefined;
  access: SubjectEntry | undefined;
};

/** A file as an operator downloads it: its view, which names it and gives its media type, and its bytes. */
export type SharedFileDownload = { file: FileView; bytes: Buffer };

/** The user as the artifact actor of the page's scope, with the private guilds they do not operate hidden from them. */
export async function loadSharedFileActor(db: Queryable, page: FilesPage, user: UserRow): Promise<ArtifactActor> {
  if (page.scope === "agent") {
    const { agent } = page;
    return loadOperatorActor(db, user, { orgId: agent.org_id, guildId: agent.guild_id, agentId: agent.id });
  }
  if (page.scope === "guild") {
    return loadOperatorActor(db, user, { orgId: page.guild.org_id, guildId: page.guild.id });
  }
  return loadOperatorActor(db, user, { orgId: page.orgId });
}

/** The files the page lists that `user` may read, by name. */
export async function listSharedFiles(deps: SharedFileReadDeps, page: FilesPage, user: UserRow): Promise<FileView[]> {
  const actor = await loadSharedFileActor(deps.db, page, user);
  if (page.scope === "agent") {
    return deps.files.listAgentFiles(actor, { agentId: page.agent.id, guildId: page.agent.guild_id });
  }
  if (page.scope === "guild") {
    return deps.files.listGuildFiles(actor, page.guild.id);
  }
  return deps.files.listOrgFiles(actor);
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

/** Announces a changed file to each guild in `guildIds`. */
async function announceFile(deps: SharedFileWriteDeps, guildIds: string[], displayPath: string): Promise<void> {
  for (const guildId of guildIds) {
    await deps.publishSharedFileChanged?.(guildId, { displayPath });
  }
}

/**
 * Stores the upload as the organisation's file of its name, or a new version of the file of that
 * name, and announces it to each guild its access list names.
 */
export async function uploadSharedFile(
  deps: SharedFileWriteDeps,
  actor: ArtifactActor,
  upload: SharedFileUpload,
): Promise<FileView> {
  const { access, expectedVersion, ...file } = upload;
  const startingAccess = [access ? parseGrant(access, "access: ") : creatorGrant(actor)];
  const row = await deps.files.putFile(actor, {
    ...file,
    startingAccess,
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
  });
  const view = deps.files.view(row);
  await announceFile(deps, await guildsOnList(deps.artifacts, actor, { kind: "file", id: row.id }), view.display_path);
  return view;
}

/** Deletes the file with this id as `actor`, and announces it to each guild its access list named. */
export async function deleteSharedFile(deps: SharedFileWriteDeps, actor: ArtifactActor, fileId: string): Promise<void> {
  const row = await deps.files.loadFileById(actor, fileId);
  const guilds = await guildsOnList(deps.artifacts, actor, { kind: "file", id: row.id });
  await deps.files.deleteFile(actor, row);
  await announceFile(deps, guilds, deps.files.view(row).display_path);
}
