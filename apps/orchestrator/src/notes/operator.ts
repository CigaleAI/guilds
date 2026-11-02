import { loadOperatorActor } from "../artifacts/actors.js";
import { creatorGrant, parseGrant, type SubjectEntry } from "../artifacts/access.js";
import { guildsOnList } from "../artifacts/access-lists.js";
import type { ArtifactActor } from "../artifacts/types.js";
import type { ArtifactStore, HostNoteView } from "../artifacts/store.js";
import {
  deleteHostNote,
  ensureAgentArtifacts,
  hostFileName,
  type HostFilePayload,
  readAgentHostFile,
  readHostNote,
  writeAgentHostFile,
  writeHostNote,
} from "../artifacts/host-files.js";
import { listAgentNotes, listGuildNotes, listOrgNotes } from "../artifacts/notes.js";
import { noteDisplayPath } from "../artifacts/paths.js";
import { ArtifactError } from "../artifacts/errors.js";
import { getLiveNote } from "../db/artifacts.js";
import type { AgentRow } from "../db/agents.js";
import type { GuildRow } from "../db/guilds.js";
import type { Queryable } from "../db/pg.js";
import type { GroupChat } from "../groupchat/index.js";
import { memoryHistory, type MemoryHistory } from "../memory/history.js";
import type { UserRow } from "../db/users.js";

/** What an operator's notes are read and written through, built once from the app's services. */
export type OperatorNotesServices = {
  db: Queryable;
  artifacts: ArtifactStore;
  /** The guild streams a change is announced on; absent on a box without a generation loop. */
  stream: Pick<GroupChat, "publish"> | null;
};

/**
 * The page whose notes a listing shows: the organisation's lists every note, a guild's the notes
 * whose access list has a row for the guild or one of its agents, an agent's the notes it reads.
 */
export type NotesPage =
  | { scope: "org"; orgId: string }
  | { scope: "guild"; guild: GuildRow }
  | { scope: "agent"; agent: AgentRow };

/**
 * A note as an operator writes it by key: its key, its content, and the subject and mode of the row
 * its access list starts with when the write creates it; without one, the organisation writes it.
 */
export type NoteWrite = { path: string; content: string; access: SubjectEntry | undefined };

/** An agent's `task.md` or `memory.md` as an operator writes it: its name, its content, and the version they edited, when they say. */
export type AgentFileWrite = {
  path: string;
  content: string;
  expectedVersion: number | null | undefined;
};

/** The user as the artifact actor of the agent; the agent's Task and Memory rows exist from then on. */
async function agentActorFor(services: OperatorNotesServices, agent: AgentRow, user: UserRow): Promise<ArtifactActor> {
  const actor = await loadOperatorActor(services.db, user, {
    orgId: agent.org_id,
    guildId: agent.guild_id,
    agentId: agent.id,
  });
  await ensureAgentArtifacts(services.artifacts, actor, agent);
  return actor;
}

/** Announces a changed note on the stream of each guild its access list names. */
async function announceNote(services: OperatorNotesServices, guildIds: string[], path: string): Promise<void> {
  if (services.stream === null) {
    return;
  }
  for (const guildId of guildIds) {
    await services.stream.publish(guildId, "guild.artifacts.changed", { path });
  }
}

/** The guilds the access list of the organisation's note at `key` names; none when there is no such note. */
async function noteGuilds(services: OperatorNotesServices, actor: ArtifactActor, key: string): Promise<string[]> {
  const live = await getLiveNote(services.db, actor.orgId, key);
  return live ? guildsOnList(services.artifacts, actor, { kind: "note", id: live.id }) : [];
}

/** A request's `expected_version`: a version, or undefined when it names none. */
function validateExpectedVersion(value: number | null | undefined): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new ArtifactError("expected_version must be an integer", 422);
  }
  return value;
}

/** The notes the page lists, as the user reads them. */
export async function listPageNotes(services: OperatorNotesServices, page: NotesPage, user: UserRow): Promise<HostNoteView[]> {
  if (page.scope === "org") {
    return listOrgNotes(services.artifacts, await loadOperatorActor(services.db, user, { orgId: page.orgId }));
  }
  if (page.scope === "guild") {
    const actor = await loadOperatorActor(services.db, user, { orgId: page.guild.org_id, guildId: page.guild.id });
    return listGuildNotes(services.artifacts, actor, page.guild.id);
  }
  const actor = await agentActorFor(services, page.agent, user);
  return listAgentNotes(services.artifacts, actor, { agentId: page.agent.id, guildId: page.agent.guild_id });
}

/** The organisation's note with this key. */
export async function readOrgNote(
  services: OperatorNotesServices,
  orgId: string,
  user: UserRow,
  path: string,
): Promise<HostFilePayload> {
  const actor = await loadOperatorActor(services.db, user, { orgId });
  return readHostNote({ store: services.artifacts, db: services.db }, actor, path);
}

/**
 * Writes the organisation's note at the write's key, creating it with the write's starting row when
 * it is missing, and announces it on the stream of each guild its access list names.
 */
export async function writeOrgNote(
  services: OperatorNotesServices,
  orgId: string,
  user: UserRow,
  write: NoteWrite,
): Promise<HostFilePayload> {
  const actor = await loadOperatorActor(services.db, user, { orgId });
  const startingAccess = [write.access ? parseGrant(write.access, "access: ") : creatorGrant(actor)];
  const hostServices = { store: services.artifacts, db: services.db };
  const written = await writeHostNote(hostServices, actor, { path: write.path, content: write.content, startingAccess });
  if (written.id) {
    const guilds = await guildsOnList(services.artifacts, actor, { kind: "note", id: written.id });
    await announceNote(services, guilds, written.display_path);
  }
  return written;
}

/** Deletes the organisation's note with this key, and announces it on the stream of each guild its access list named. */
export async function deleteOrgNote(
  services: OperatorNotesServices,
  orgId: string,
  user: UserRow,
  path: string,
): Promise<void> {
  const actor = await loadOperatorActor(services.db, user, { orgId });
  const key = hostFileName(path);
  const guilds = await noteGuilds(services, actor, key);
  await deleteHostNote(services.artifacts, actor, key);
  const displayPath = noteDisplayPath(orgId, key);
  await announceNote(services, guilds, displayPath);
}

/** The agent's `task.md` or `memory.md`. */
export async function readAgentFile(
  services: OperatorNotesServices,
  agent: AgentRow,
  user: UserRow,
  path: string,
): Promise<HostFilePayload> {
  const actor = await agentActorFor(services, agent, user);
  return readAgentHostFile({ store: services.artifacts, db: services.db }, actor, agent.id, path);
}

/** Writes the agent's `task.md` or `memory.md`, and announces it on the agent's guild stream; only `task.md` checks a version. */
export async function writeAgentFile(
  services: OperatorNotesServices,
  agent: AgentRow,
  user: UserRow,
  write: AgentFileWrite,
): Promise<HostFilePayload> {
  const expectedVersion = validateExpectedVersion(write.expectedVersion);
  const actor = await agentActorFor(services, agent, user);
  const hostWrite = { path: write.path, content: write.content, expectedVersion };
  const written = await writeAgentHostFile({ store: services.artifacts, db: services.db }, actor, agent.id, hostWrite);
  if (services.stream !== null) {
    await services.stream.publish(agent.guild_id, "guild.artifacts.changed", {
      scope: "agent",
      agent_id: agent.id,
      path: write.path,
    });
  }
  return written;
}

/** The agent's memory as it was, version by version. */
export async function readMemoryHistory(
  services: OperatorNotesServices,
  agent: AgentRow,
  user: UserRow,
): Promise<MemoryHistory> {
  const actor = await agentActorFor(services, agent, user);
  return memoryHistory({ artifacts: services.artifacts, db: services.db }, actor, {
    id: agent.id,
    name: agent.name,
  });
}
