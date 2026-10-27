import { loadOperatorActor, type ArtifactActor, type ArtifactStore } from "../artifacts/index.js";
import {
  deleteHostFile,
  ensureAgentArtifacts,
  listHostFiles,
  readHostFile,
  writeHostFile,
  type HostFileOwner,
} from "../artifacts/host-files.js";
import { ArtifactError } from "../artifacts/errors.js";
import type { AgentRow } from "../db/agents.js";
import type { GuildRow } from "../db/guilds.js";
import type { Queryable } from "../db/pg.js";
import type { GroupChat } from "../groupchat/index.js";
import { memoryHistory } from "../memory/history.js";

/** What an operator's notes are read and written through, built once from the app's services. */
export type OperatorNotesServices = {
  db: Queryable;
  artifacts: ArtifactStore;
  /** The guild streams a change is announced on; absent on a box without a generation loop. */
  stream: Pick<GroupChat, "publish"> | null;
};

/** Whose notes a page shows: a guild's, an agent's, or the organisation's. */
export type NotesOwner =
  | { level: "guild"; guild: GuildRow }
  | { level: "agent"; agent: AgentRow }
  | { level: "org"; orgId: string };

/** A note as an operator writes it: its path, its content, and the version they edited, when they say. */
export type NoteWrite = { path: string; content: string; expectedVersion: unknown };

function hostOwnerOf(owner: NotesOwner): HostFileOwner {
  if (owner.level === "guild") {
    return { level: "guild", ownerId: owner.guild.id };
  }
  if (owner.level === "agent") {
    return { level: "agent", ownerId: owner.agent.id };
  }
  return { level: "org", ownerId: owner.orgId };
}

/** The user as the artifact actor of the owner's scope; an agent's Task and Memory rows exist from then on. */
async function actorFor(
  services: OperatorNotesServices,
  owner: NotesOwner,
  user: Record<string, unknown>,
): Promise<ArtifactActor> {
  if (owner.level === "org") {
    return loadOperatorActor(services.db, user, { orgId: owner.orgId });
  }
  if (owner.level === "guild") {
    return loadOperatorActor(services.db, user, {
      orgId: owner.guild.org_id,
      guildId: owner.guild.id,
    });
  }
  const { agent } = owner;
  const actor = await loadOperatorActor(services.db, user, {
    orgId: agent.org_id,
    guildId: agent.guild_id,
    agentId: agent.id,
  });
  await ensureAgentArtifacts(services.artifacts, actor, agent);
  return actor;
}

/** Announces a changed note on its guild's stream; the organisation's notes have no stream. */
async function announce(
  services: OperatorNotesServices,
  owner: NotesOwner,
  path: string,
): Promise<void> {
  if (services.stream === null || owner.level === "org") {
    return;
  }
  if (owner.level === "guild") {
    await services.stream.publish(owner.guild.id, "guild.artifacts.changed", {
      scope: "guild",
      path,
    });
    return;
  }
  const data = { scope: "agent", agent_id: owner.agent.id, path };
  await services.stream.publish(owner.agent.guild_id, "guild.artifacts.changed", data);
}

/** A request's `expected_version`: a version, or undefined when it names none. */
function validateExpectedVersion(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const version = Number(value);
  if (!Number.isInteger(version) || version < 0) {
    throw new ArtifactError("expected_version must be an integer", 422);
  }
  return version;
}

export async function listOwnerNotes(
  services: OperatorNotesServices,
  owner: NotesOwner,
  user: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  return listHostFiles(
    services.artifacts,
    await actorFor(services, owner, user),
    hostOwnerOf(owner),
  );
}

export async function readOwnerNote(
  services: OperatorNotesServices,
  owner: NotesOwner,
  user: Record<string, unknown>,
  path: string,
): Promise<Record<string, unknown>> {
  const actor = await actorFor(services, owner, user);
  return readHostFile(
    { store: services.artifacts, db: services.db },
    actor,
    hostOwnerOf(owner),
    path,
  );
}

/** Writes the note and announces it on the owner's guild stream; only an agent's notes check a version. */
export async function writeOwnerNote(
  services: OperatorNotesServices,
  owner: NotesOwner,
  user: Record<string, unknown>,
  write: NoteWrite,
): Promise<Record<string, unknown>> {
  const expectedVersion =
    owner.level === "agent" ? validateExpectedVersion(write.expectedVersion) : undefined;
  const actor = await actorFor(services, owner, user);
  const hostWrite = { path: write.path, content: write.content, expectedVersion };
  const store = { store: services.artifacts, db: services.db };
  const written = await writeHostFile(store, actor, hostOwnerOf(owner), hostWrite);
  await announce(services, owner, write.path);
  return written;
}

/** Deletes the note and announces it on the owner's guild stream. */
export async function deleteOwnerNote(
  services: OperatorNotesServices,
  owner: NotesOwner,
  user: Record<string, unknown>,
  path: string,
): Promise<void> {
  await deleteHostFile(
    services.artifacts,
    await actorFor(services, owner, user),
    hostOwnerOf(owner),
    path,
  );
  await announce(services, owner, path);
}

/** The agent's memory as it was, version by version. */
export async function readMemoryHistory(
  services: OperatorNotesServices,
  agent: AgentRow,
  user: Record<string, unknown>,
): Promise<unknown> {
  const actor = await actorFor(services, { level: "agent", agent }, user);
  return memoryHistory({ artifacts: services.artifacts, db: services.db }, actor, {
    id: agent.id,
    name: agent.name,
  });
}
