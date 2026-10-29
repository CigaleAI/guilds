// The rows of an item's access list as they are written, and the change-log entry each change
// to one of them makes.
import {
  deleteAccessRow,
  getAccessSubject,
  listAccessEntries,
  upsertAccessRow,
} from "../db/artifact-access.js";
import type { CollectionQueryRow } from "../db/collections.js";
import { recordConfigChange, type ConfigChange } from "../db/config-changes.js";
import type { Queryable } from "../db/pg.js";
import { grantKey, grantSummary, parseGrant } from "./access.js";
import { ArtifactError } from "./errors.js";
import type {
  AccessEntry,
  AccessGrant,
  AccessSubject,
  AccessTarget,
  AgentAccessMode,
  ArtifactActor,
} from "./types.js";

/** Writes or replaces the rows of `grants` on an item's access list. */
export async function writeGrants(
  db: Queryable,
  actor: ArtifactActor,
  target: AccessTarget,
  grants: AccessGrant[],
): Promise<void> {
  for (const grant of grants) {
    await upsertAccessRow(db, { ...target, orgId: actor.orgId }, grant, actor);
  }
}

/** Removes the rows of `grants` from an item's access list. */
export async function removeGrants(db: Queryable, target: AccessTarget, grants: AccessGrant[]): Promise<void> {
  for (const grant of grants) {
    await deleteAccessRow(db, target, grant);
  }
}

/** An item whose access list is being changed, as its change-log entries name it. */
export type AccessItem = {
  target: AccessTarget;
  orgId: string;
  guildId: string | null;
  /** The agent that owns an agent-level note, which always writes it. */
  ownerAgentId: string | null;
  label: string;
};

/** How a change-log line names a subject. */
export function subjectLabel(type: AccessSubject, name: string): string {
  return type === "org" ? "the organisation" : `${type} ${name}`;
}

/** Refuses a row naming the agent that owns the item: it always writes its own note or file. */
export function assertNotOwner(item: AccessItem, grant: AccessGrant, where = ""): void {
  if (grant.type === "agent" && grant.id === item.ownerAgentId) {
    throw new ArtifactError(
      `${where}the agent that owns the ${item.target.kind} always writes it`,
      422,
    );
  }
}

/** The change-log entry for one subject's row on `item` going to `mode`, or removed when null. */
export function accessChange(
  item: AccessItem,
  subject: string,
  mode: AgentAccessMode | null,
  existed: boolean,
): ConfigChange {
  return {
    orgId: item.orgId,
    guildId: item.guildId,
    targetKind: item.target.kind,
    targetId: item.target.id,
    operation: mode === null ? "delete" : existed ? "update" : "create",
    summary: grantSummary(subject, item.label, mode),
  };
}

/** A collection as the change-log entries of its access list name it. */
export function collectionAccessItem(
  collection: Pick<CollectionQueryRow, "id" | "org_id" | "guild_id" | "name">,
): AccessItem {
  return {
    target: { kind: "collection", id: collection.id },
    orgId: collection.org_id,
    guildId: collection.guild_id,
    ownerAgentId: null,
    label: `the table ${collection.name}`,
  };
}

/**
 * The name of the organisation, guild, or agent a grant names. A subject
 * that does not exist, is in another organisation, or is in a guild the
 * actor cannot see is a 422 prefixed by `where`.
 */
export async function requireSubject(
  db: Queryable,
  actor: ArtifactActor,
  subject: { type: AccessSubject; id: string },
  where = "",
): Promise<string> {
  const row = await getAccessSubject(db, actor.orgId, subject);
  if (!row || (row.guild_id !== null && actor.hidden.guildIds.includes(row.guild_id))) {
    throw new ArtifactError(`${where}unknown ${subject.type}`, 422);
  }
  return row.name;
}

/** An item's access list, without the guilds, and their agents, the actor cannot see. */
export async function loadEntries(
  db: Queryable,
  actor: ArtifactActor,
  target: AccessTarget,
): Promise<AccessEntry[]> {
  const entries = await listAccessEntries(db, target);
  return entries.filter(
    (entry) => !entry.guild_id || !actor.hidden.guildIds.includes(entry.guild_id),
  );
}

/** One subject's row a change sets on an item's access list; a null mode removes the row. */
export type AccessRowChange = { type: AccessSubject; id: string; mode: AgentAccessMode | null };

/**
 * Sets one subject's row on `item`'s access list on `client`, or removes it when the row's `mode`
 * is null, and logs the change. A row already at `mode` is left as it is. Only a subject whose row
 * is written must exist.
 */
export async function setAccessRow(
  client: Queryable,
  actor: ArtifactActor,
  item: AccessItem,
  row: AccessRowChange,
): Promise<void> {
  const { target } = item;
  const mode = row.mode;
  const grant = parseGrant({ type: row.type, id: row.id, mode: mode ?? "read" });
  const before = (await loadEntries(client, actor, target)).find(
    (entry) => grantKey(entry) === grantKey(grant),
  );
  if ((before?.mode ?? null) === mode) {
    return;
  }
  let name = before?.name ?? grant.id;
  if (mode === null) {
    await removeGrants(client, target, [grant]);
  } else {
    assertNotOwner(item, grant);
    name = await requireSubject(client, actor, grant);
    await writeGrants(client, actor, target, [{ ...grant, mode }]);
  }
  await recordConfigChange(
    client,
    actor,
    accessChange(item, subjectLabel(grant.type, name), mode, before !== undefined),
  );
}
