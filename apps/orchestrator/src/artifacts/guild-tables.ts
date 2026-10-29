// The tables a guild's agents are given, the guild's own and the organisation's, each with its
// access list, the steps the operator applies to them, and what an edit does to their records
// and readers.
import { type AccessRowChange, grantAccess, listAccess } from "./access-lists.js";
import {
  createCollection,
  deleteCollection,
  describeCollection,
  getCollection,
  listCollections,
  listCollectionsWithCounts,
  updateCollection,
  type CollectionChanges,
  type NewCollection,
} from "./collections.js";
import type { ColumnChange } from "./columns.js";
import { ArtifactError } from "./errors.js";
import type { ArtifactStore, CollectionView } from "./store.js";
import type { AccessEntry, ArtifactActor } from "./types.js";
import type { CollectionColumn } from "../db/schema/index.js";

/** A collection as the operator reads it, with its access list. */
export type CollectionAccess = { collection: CollectionView; access: AccessEntry[] };

/** A collection named by its id or by its name. */
export type CollectionLookup = { id: string } | { name: string };

/** Whether a collection is one a guild's agents are given in the guild's own right: the guild's own, or the organisation's. */
function isGuildOrOrgTable(collection: CollectionView, guildId: string): boolean {
  return !collection.guild || collection.guild.id === guildId;
}

/** The guild's own collections and the organisation's, of those `listCollections` gives the actor. */
export async function listGuildCollections(store: ArtifactStore, actor: ArtifactActor, guildId: string): Promise<CollectionView[]> {
  return (await listCollections(store, actor)).filter((collection) => isGuildOrOrgTable(collection, guildId));
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

/** A guild table as an edit finds it: its name, its columns, its live record count, and its access list. */
export type GuildTableBefore = { name: string; columns: CollectionColumn[]; count: number; entries: AccessEntry[] };

/** What an edit leaves of a guild table: its name, and the change to its columns, null when they stay as they are. */
export type GuildTableEdit = { name: string; columns: ColumnChange | null };

/** One thing applying an edit does to a guild table's records or readers. `records` is the table's live record count. */
export type GuildTableEffect =
  | { kind: "table_renamed"; from: string; to: string }
  | { kind: "column_dropped"; column: string; records: number }
  | { kind: "column_moved"; from: string; to: string; records: number }
  | { kind: "required_column_added"; column: string; records: number }
  | { kind: "column_retyped"; column: string }
  | { kind: "column_made_required"; column: string }
  | { kind: "column_made_unique"; column: string }
  | { kind: "reached_outside_guild"; rows: AccessEntry[] };

/**
 * What applying `edit` does to a table of guild `guildId`, in order: a rename, then what the column
 * change does to its records, then the rows of other guilds and their agents that reach the table,
 * when its name or its columns change.
 */
export function guildTableEditEffects(table: GuildTableBefore, guildId: string, edit: GuildTableEdit): GuildTableEffect[] {
  const renamed = edit.name !== table.name;
  const outside = table.entries.filter((entry) => entry.type !== "org" && entry.guild_id !== guildId);
  const effects: GuildTableEffect[] = renamed ? [{ kind: "table_renamed", from: table.name, to: edit.name }] : [];
  if (edit.columns) {
    effects.push(...columnChangeEffects(table, edit.columns));
  }
  if (outside.length && (renamed || edit.columns)) {
    effects.push({ kind: "reached_outside_guild", rows: outside });
  }
  return effects;
}

/** What a column change does to a table's records: its dropped and moved columns, then each column it adds or keeps. */
function columnChangeEffects(table: GuildTableBefore, change: ColumnChange): GuildTableEffect[] {
  const records = table.count;
  const before = new Map(table.columns.map((column) => [column.name, column]));
  const fromOf = new Map(change.renamed.map((item) => [item.to, item.from]));
  return [
    ...change.removed.map((column): GuildTableEffect => ({ kind: "column_dropped", column, records })),
    ...change.renamed.map((item): GuildTableEffect => ({ kind: "column_moved", from: item.from, to: item.to, records })),
    ...change.columns.flatMap((column) => {
      const previous = before.get(fromOf.get(column.name) ?? column.name);
      return previous ? keptColumnEffects(previous, column, records) : addedColumnEffects(column, records);
    }),
  ];
}

/** A column the change adds reaches the stored records only when it is required. */
function addedColumnEffects(column: CollectionColumn, records: number): GuildTableEffect[] {
  return column.required && records ? [{ kind: "required_column_added", column: column.name, records }] : [];
}

/** What a kept column's new definition does to the stored records: a retype keeps their values; a new requirement or uniqueness checks them. */
function keptColumnEffects(previous: CollectionColumn, column: CollectionColumn, records: number): GuildTableEffect[] {
  const effects: GuildTableEffect[] = [];
  if (isRetyped(previous, column)) {
    effects.push({ kind: "column_retyped", column: column.name });
  }
  if (column.required && !previous.required && records) {
    effects.push({ kind: "column_made_required", column: column.name });
  }
  if (column.unique && !previous.unique) {
    effects.push({ kind: "column_made_unique", column: column.name });
  }
  return effects;
}

/** Whether a column's type or its allowed values change. */
function isRetyped(previous: CollectionColumn, column: CollectionColumn): boolean {
  return previous.type !== column.type || JSON.stringify(previous.values ?? null) !== JSON.stringify(column.values ?? null);
}
