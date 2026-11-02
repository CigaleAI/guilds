import { creatorGrant, parseGrant, type SubjectEntry } from "./access.js";
import { guildsShowing } from "./access-lists.js";
import { loadOperatorActor } from "./actors.js";
import type { ArtifactFiles, FileView, PageFileView } from "./files.js";
import { homedActor, type ArtifactStore, type PageSections } from "./store.js";
import type { ArtifactActor } from "./types.js";
import type { AgentViewerMode, GuildViewerMode } from "../db/artifact-lists.js";
import type { AgentRow } from "../db/agents.js";
import type { GuildRow } from "../db/guilds.js";
import type { Queryable } from "../db/pg.js";
import type { UserRow } from "../db/users.js";

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
 * replace when they say (0 for a file that must not exist yet), and, when the upload creates it,
 * the subject and mode of the row its access list starts with (without one, the organisation writes
 * it) and the guild it is homed in (without one, the organisation).
 */
export type SharedFileUpload = {
  name: string;
  description: string;
  mime: string;
  bytes: Buffer;
  expectedVersion: number | undefined;
  access: SubjectEntry | undefined;
  homeGuildId: string | undefined;
};

/** A file as an operator downloads it: its view, which names it and gives its media type, and its bytes. */
export type SharedFileDownload = { file: FileView; bytes: Buffer };

/** Every file of the organisation `user` may read, by name. */
export async function listOrgSharedFiles(
  deps: SharedFileReadDeps,
  orgId: string,
  user: UserRow,
): Promise<Array<PageFileView<GuildViewerMode>>> {
  return deps.files.listOrgFiles(await loadOperatorActor(deps.db, user, { orgId }));
}

/** The files the guild's page lists for `user`, in its two sections. */
export async function listGuildSharedFiles(
  deps: SharedFileReadDeps,
  guild: GuildRow,
  user: UserRow,
): Promise<PageSections<PageFileView<GuildViewerMode>>> {
  const actor = await loadOperatorActor(deps.db, user, { orgId: guild.org_id, guildId: guild.id });
  return deps.files.listGuildFiles(actor, guild.id);
}

/** The files the agent's page lists for `user`, in its two sections. */
export async function listAgentSharedFiles(
  deps: SharedFileReadDeps,
  agent: AgentRow,
  user: UserRow,
): Promise<PageSections<PageFileView<AgentViewerMode>>> {
  const actor = await loadOperatorActor(deps.db, user, { orgId: agent.org_id, guildId: agent.guild_id, agentId: agent.id });
  return deps.files.listAgentFiles(actor, { agentId: agent.id, guildId: agent.guild_id });
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
 * name, and announces it to each guild whose page lists it. ArtifactError 404 when the home names
 * a guild that is unknown or hidden from the actor.
 */
export async function uploadSharedFile(
  deps: SharedFileWriteDeps,
  operator: ArtifactActor,
  upload: SharedFileUpload,
): Promise<FileView> {
  const { access, expectedVersion, homeGuildId, ...file } = upload;
  const actor = await homedActor(deps.artifacts, operator, homeGuildId);
  const startingAccess = [access ? parseGrant(access, "access: ") : creatorGrant(actor)];
  const row = await deps.files.putFile(actor, {
    ...file,
    startingAccess,
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
  });
  const view = deps.files.view(row);
  await announceFile(deps, await guildsShowing(deps.artifacts, actor, { kind: "file", id: row.id }), view.display_path);
  return view;
}

/** Deletes the file with this id as `actor`, and announces it to each guild whose page listed it. */
export async function deleteSharedFile(deps: SharedFileWriteDeps, actor: ArtifactActor, fileId: string): Promise<void> {
  const row = await deps.files.loadFileById(actor, fileId);
  const guilds = await guildsShowing(deps.artifacts, actor, { kind: "file", id: row.id });
  await deps.files.deleteFile(actor, row);
  await announceFile(deps, guilds, deps.files.view(row).display_path);
}
