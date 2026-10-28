import type { AccessMode, CollectionColumn } from "../db/schema/index.js";
import { grantAccess, listAccess } from "./access-lists.js";
import {
  collectionFacts,
  createCollection,
  deleteCollection,
  describeCollection,
  getCollection,
  listCollectionsWithCounts,
  updateCollection,
  validateCollectionName,
  validatePurpose,
  type CollectionChanges,
  type CollectionFacts,
  type NewCollection,
} from "./collections.js";
import { describeColumn, parseColumnChange, parseColumns, type ColumnChange } from "./columns.js";
import { ArtifactError } from "./errors.js";
import { getMemoryRow, listRevisions } from "./memory.js";
import { buildMemoryTimeline, type MemoryTimelineEntry } from "./memory-timeline.js";
import { collectionDisplayPath, displayPathFor, MEMORY_KEY } from "./paths.js";
import { listRecords } from "./records.js";
import { type ArtifactStore, type CollectionView, type RecordView } from "./store.js";
import {
  isAccessMode,
  type AccessEntry,
  type AccessGrant,
  type AccessSubject,
  type AccessTarget,
  type AgentAccessMode,
  type ArtifactActor,
} from "./types.js";

/** Every version an agent's Memory has held, newest first, with its display path and the live version and hash. */
export type MemoryTimeline = {
  displayPath: string;
  /** The live Memory's version and the hash of its text; null when the agent has no Memory. */
  live: { version: number; contentHash: string } | null;
  entries: MemoryTimelineEntry[];
};

/** The agent's Memory as the actor reads its versions: the archived ones only reach an operator. */
export async function memoryTimeline(store: ArtifactStore, actor: ArtifactActor, agentId: string): Promise<MemoryTimeline> {
  const live = await getMemoryRow(store, actor, agentId);
  const revisions = await listRevisions(store, actor, agentId);
  return {
    displayPath: displayPathFor({ orgId: actor.orgId, level: "agent", ownerId: agentId, kind: "memory", path: "", key: MEMORY_KEY }),
    live: live ? { version: live.version, contentHash: live.content_hash } : null,
    entries: buildMemoryTimeline({ live: { content: live?.content_text ?? "" }, revisions }),
  };
}

/** Who an access list is read for: a guild, or one agent of that guild. */
export type AccessReader = { guildId: string; agentId: string | null };

/**
 * The mode an item's access list gives `reader`: an agent's own row when it has one, `none`
 * meaning no access; otherwise the better of its guild's row and the organisation's, `write`
 * implying `read`. Null when no row reaches it.
 */
export function effectiveAccess(entries: AccessGrant[], reader: AccessReader): AccessMode | null {
  const own = reader.agentId === null ? undefined : entries.find((entry) => entry.type === "agent" && entry.id === reader.agentId);
  if (own) {
    return isAccessMode(own.mode) ? own.mode : null;
  }
  const guild = entries.find((entry) => entry.type === "guild" && entry.id === reader.guildId)?.mode;
  const org = entries.find((entry) => entry.type === "org")?.mode;
  if (guild === "write" || org === "write") {
    return "write";
  }
  return isAccessMode(guild) || isAccessMode(org) ? "read" : null;
}

/** What an item's access list is raised to: a guild to at least `mode` when one is named, and each of `writerIds`, agents of that guild, to write. */
export type AccessRaise = { guildId: string; mode: AccessMode | null; writerIds: string[] };

/**
 * The rows that bring the guild up to `raise.mode` and each writer up to write, guild first. A
 * subject that already holds as much, its guild's row once raised included, gets no row, so a row
 * is never lowered.
 */
export function accessRaises(entries: AccessGrant[], raise: AccessRaise): AccessGrant[] {
  const held = effectiveAccess(entries, { guildId: raise.guildId, agentId: null });
  const wanted = raise.mode;
  const raisesGuild = wanted !== null && (wanted === "write" ? held !== "write" : held === null);
  const guildRows: AccessGrant[] = raisesGuild ? [{ type: "guild", id: raise.guildId, mode: wanted }] : [];
  const raised = [...guildRows, ...entries];
  const writers: AccessGrant[] = raise.writerIds
    .filter((agentId) => effectiveAccess(raised, { guildId: raise.guildId, agentId }) !== "write")
    .map((agentId) => ({ type: "agent", id: agentId, mode: "write" }));
  return [...guildRows, ...writers];
}

/** Raises an item's access list as the operator to what `raise` names, writing only the rows `accessRaises` gives. */
export async function raiseAccess(store: ArtifactStore, actor: ArtifactActor, target: AccessTarget, raise: AccessRaise): Promise<void> {
  const entries = await listAccess(store, actor, target);
  for (const grant of accessRaises(entries, raise)) {
    await grantAccess(store, actor, target, grant);
  }
}

/** A collection as the operator reads it, with its access list. */
export type CollectionAccess = { collection: CollectionView; access: AccessEntry[] };

/** A collection named by its id or by its name. */
export type CollectionLookup = { id: string } | { name: string };

/** Whether a collection is one a guild's agents are given in the guild's own right: the guild's own, or the organisation's. */
function isGuildOrOrgTable(collection: CollectionView, guildId: string): boolean {
  return !collection.guild || collection.guild.id === guildId;
}

/**
 * The guild's own tables and the organisation's, as the operator `actor` sees them, each with its
 * live record count and its access list.
 */
export async function guildTables(store: ArtifactStore, actor: ArtifactActor, guildId: string): Promise<CollectionAccess[]> {
  const tables: CollectionAccess[] = [];
  for (const collection of await listCollectionsWithCounts(store, actor)) {
    if (isGuildOrOrgTable(collection, guildId)) {
      tables.push({ collection, access: await listAccess(store, actor, { kind: "collection", id: collection.id }) });
    }
  }
  return tables;
}

/**
 * One of `guildTables`, with its live record count and its access list. Null when the lookup names
 * no live collection the operator `actor` sees, or another guild's own table.
 */
export async function guildTable(
  store: ArtifactStore,
  actor: ArtifactActor,
  guildId: string,
  lookup: CollectionLookup,
): Promise<CollectionAccess | null> {
  const described = "name" in lookup ? await describeCollection(store, actor, lookup.name) : null;
  const id = "name" in lookup ? described?.id : lookup.id;
  if (id === undefined) {
    return null;
  }
  let table: CollectionAccess;
  try {
    table = {
      collection: await getCollection(store, actor, id),
      access: await listAccess(store, actor, { kind: "collection", id }),
    };
  } catch (error) {
    if (error instanceof ArtifactError && error.status === 404) {
      return null;
    }
    throw error;
  }
  return isGuildOrOrgTable(table.collection, guildId) ? table : null;
}

/** A new collection checked before anything writes it: its name, purpose and columns as stored, and the display path it takes. */
export type CheckedCollection = { name: string; purpose: string; columns: CollectionColumn[]; href: string };

/**
 * Checks a new collection's name, purpose and columns, in that order, before anything writes it.
 * ArtifactError on the first that fails.
 */
export function planCollection(orgId: string, draft: Pick<NewCollection, "name" | "purpose" | "columns">): CheckedCollection {
  const name = validateCollectionName(draft.name);
  const purpose = validatePurpose(draft.purpose);
  const columns = parseColumns(draft.columns ?? []);
  return { name, purpose, columns, href: collectionDisplayPath(orgId, name) };
}

/** A change to a collection's definition checked before anything writes it: the name and purpose it leaves, and its column change when it replaces the columns. */
export type CheckedCollectionChange = { name: string; purpose: string; columns: ColumnChange | null };

/**
 * Checks a change's name, purpose and columns, in that order, against the collection it changes,
 * before anything writes it. A field the change leaves out keeps the collection's. ArtifactError on
 * the first that fails.
 */
export function planCollectionChange(
  current: Pick<CollectionView, "name" | "purpose" | "columns">,
  changes: CollectionChanges,
): CheckedCollectionChange {
  const name = changes.name === undefined ? current.name : validateCollectionName(changes.name);
  const purpose = changes.purpose === undefined ? current.purpose : validatePurpose(changes.purpose);
  const columns = changes.columns === undefined ? null : parseColumnChange(current.columns, changes.columns);
  return { name, purpose, columns };
}

/** One subject's row a collection step sets on the collection's access list; a null mode removes the row. */
export type AccessRowChange = { type: AccessSubject; id: string; mode: AgentAccessMode | null };

/** One change to a collection as the operator applies it: a create or an edit with the access rows it then sets, or a delete. */
export type CollectionStep =
  | { action: "create"; collection: NewCollection; access: AccessRowChange[] }
  | { action: "edit"; id: string; changes: CollectionChanges | null; access: AccessRowChange[] }
  | { action: "delete"; id: string };

/** Applies a step as the operator: the collection first, created, changed or deleted, then each access row in order. */
export async function applyCollectionStep(store: ArtifactStore, actor: ArtifactActor, step: CollectionStep): Promise<void> {
  if (step.action === "delete") {
    await deleteCollection(store, actor, step.id);
    return;
  }
  const id = step.action === "create" ? (await createCollection(store, actor, step.collection)).id : step.id;
  if (step.action === "edit" && step.changes) {
    await updateCollection(store, actor, id, step.changes);
  }
  for (const row of step.access) {
    await grantAccess(store, actor, { kind: "collection", id }, row);
  }
}

/**
 * A listing of one collection's records: `where` a term per column, `since` a moment records
 * changed at or after, `order`, and the page.
 */
export type RecordQuery = {
  collection: string;
  where?: Record<string, unknown> | undefined;
  since?: string | undefined;
  order?: unknown;
  limit?: unknown;
  offset?: unknown;
};

/** A page of records, how many match in all, and what a narrowed listing that finds nothing says about its collection. */
export type RecordList = { total: number; records: RecordView[]; hint: string | null };

/**
 * Lists a collection's records as `listRecords` does. A listing narrowed by `where` or `since`
 * that finds nothing carries the hint `recordListHint` writes from the collection's facts.
 */
export async function listRecordsWithHint(store: ArtifactStore, actor: ArtifactActor, query: RecordQuery): Promise<RecordList> {
  const listed = await listRecords(store, actor, query);
  const narrowed = Boolean(query.where || query.since);
  const facts = listed.records.length === 0 && narrowed ? await collectionFacts(store, actor, query.collection) : null;
  return { total: listed.total, records: listed.records, hint: facts ? recordListHint(query, facts) : null };
}

/**
 * What a narrowed listing that finds nothing says: what was asked, what the collection holds, and
 * its columns, so the next call narrows differently instead of asking for a larger limit.
 */
export function recordListHint(query: RecordQuery, facts: CollectionFacts): string {
  const narrowing = [
    query.since ? `changed at or after ${query.since}` : "",
    query.where ? `where ${JSON.stringify(query.where)}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const holds =
    facts.count === 0
      ? `${query.collection} holds no records yet.`
      : `${query.collection} holds ${facts.count} record${facts.count === 1 ? "" : "s"}; the newest changed at ${facts.newest_updated_at}.`;
  const columns = facts.columns.length ? `Its columns: ${facts.columns.map(describeColumn).join("; ")}.` : "";
  const advice = query.since
    ? "An empty result is the answer; a larger limit will not change it. since is for picking up new work — " +
      "to check whether something is already recorded, use where on the unique column or record_search."
    : "An empty result is the answer; a larger limit will not change it. where matches by column type " +
      "(text or an open array item by substring, a closed list exactly, null a missing value); record_search matches words in the values.";
  return [`No records in ${query.collection} ${narrowing}.`, holds, columns, advice].filter(Boolean).join(" ");
}
