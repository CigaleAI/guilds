import { deleteAccessList, readAgentMode } from "../db/artifact-access.js";
import { formatOperationalTimestamp } from "../db/codecs.js";
import {
  clearRecordIdentities,
  collectionRecordFacts,
  countLiveCollections,
  countLiveRecords,
  countLiveRecordsByCollection,
  dropRecordKey,
  getCollectionById,
  getCollectionByName,
  insertCollection,
  listLiveRecordBodies,
  listOrgCollections,
  listReachedCollections,
  lockCollection,
  lockLiveCollection,
  refreshRecordSearchBlobs,
  renameRecordKey,
  setRecordIdentity,
  softDeleteCollection,
  softDeleteRecords,
  updateCollection as writeCollection,
  type CollectionQueryRow,
} from "../db/collections.js";
import { recordChangeIfAny, recordConfigChange } from "../db/config-changes.js";
import { getGuild } from "../db/guilds.js";
import { isUniqueViolation, type Queryable, withTransaction } from "../db/pg.js";
import type { CollectionColumn } from "../db/schema/index.js";
import { defaultGrants, reachedMode } from "./access.js";
import {
  collectionCleared,
  collectionColumnsChanged,
  collectionDeleted,
  type CollectionRef,
} from "./collection-changes.js";
import { columnCatalog, normalizeIdentity, parseColumnChange, parseColumns, uniqueColumn } from "./columns.js";
import { ArtifactError } from "./errors.js";
import { writeGrants } from "./grants.js";
import { collectionDisplayPath } from "./paths.js";
import type { ArtifactStore, CollectionDescription, CollectionView } from "./store.js";
import {
  COLLECTION_NAME_RE,
  LIVE_COLLECTIONS_MAX,
  PURPOSE_MAX,
  STATE_COLLECTIONS_MAX,
  type AccessMode,
  type ArtifactActor,
} from "./types.js";


/** What a collection's update may change; a field left out keeps its value. */
export type CollectionChanges = { name?: string; purpose?: string; columns?: unknown; guildId?: string | null };

export function validateCollectionName(name: string): string {
  const text = (name || "").trim();
  if (!COLLECTION_NAME_RE.test(text)) {
    throw new ArtifactError("collection name must match ^[a-z][a-z0-9_-]{0,62}$", 422);
  }
  return text;
}

export function validatePurpose(purpose: string): string {
  const text = (purpose || "").trim();
  if (!text) {
    throw new ArtifactError("purpose is required", 422);
  }
  if (text.length > PURPOSE_MAX) {
    throw new ArtifactError(`purpose must be at most ${PURPOSE_MAX} characters`, 422);
  }
  return text;
}

/** Refuses an actor that is not the operator: collections are the operator's to manage. */
export function assertOperator(actor: ArtifactActor): void {
  if (!actor.operator) {
    throw new ArtifactError("collections are managed by the operator", 403);
  }
}


function collectionRef(row: CollectionQueryRow): CollectionRef {
  return { id: row.id, name: row.name, orgId: row.org_id, guildId: row.guild_id };
}

/** The collection row, or null when there is none or it is the own table of a guild the actor cannot see. */
function visibleCollection(actor: ArtifactActor, row: CollectionQueryRow | null): CollectionQueryRow | null {
  if (!row || (row.guild_id && actor.hidden.guildIds.includes(row.guild_id))) {
    return null;
  }
  return row;
}

export async function loadCollectionById(
  store: ArtifactStore,
  actor: ArtifactActor,
  collectionId: string,
): Promise<CollectionQueryRow | null> {
  return visibleCollection(actor, await getCollectionById(store.db, actor.orgId, collectionId));
}

export async function loadCollectionByName(
  store: ArtifactStore,
  actor: ArtifactActor,
  name: string,
): Promise<CollectionQueryRow | null> {
  return visibleCollection(actor, await getCollectionByName(store.db, actor.orgId, name));
}

export function collectionView(row: CollectionQueryRow, access: AccessMode, count?: number): CollectionView {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    columns: row.columns,
    display_path: collectionDisplayPath(row.org_id, row.name),
    scope: row.guild_id ? "guild" : "org",
    guild: row.guild_id ? { id: row.guild_id, name: row.guild_name ?? "" } : null,
    access,
    created_at: formatOperationalTimestamp(row.created_at),
    updated_at: formatOperationalTimestamp(row.updated_at),
    ...(count !== undefined ? { count } : {}),
  };
}

/** The guild of the organisation `guildId` names, refused when it is unknown or hidden from the actor. */
async function requireGuild(store: ArtifactStore, actor: ArtifactActor, guildId: string): Promise<string> {
  const id = String(guildId ?? "").trim();
  const guild = await getGuild(store.db, id);
  if (!guild || guild.org_id !== actor.orgId || actor.hidden.guildIds.includes(id)) {
    throw new ArtifactError("unknown guild", 404);
  }
  return id;
}

/** The actor's mode on a collection from its access list. The operator writes everything. */
async function accessMode(store: ArtifactStore, actor: ArtifactActor, collection: CollectionQueryRow): Promise<AccessMode | null> {
  if (actor.operator) {
    return "write";
  }
  return reachedMode(await readAgentMode(store.db, actor, { kind: "collection", id: collection.id }));
}

/** The live collections the actor can read with its mode on each; the operator reads every one it sees. */
export async function accessibleCollections(
  store: ArtifactStore,
  actor: ArtifactActor,
): Promise<Array<{ row: CollectionQueryRow; mode: AccessMode }>> {
  if (actor.operator) {
    const rows = await listOrgCollections(store.db, actor.orgId, actor.hidden.guildIds);
    return rows.map((row) => ({ row, mode: "write" }));
  }
  const rows = await listReachedCollections(store.db, actor);
  return rows.map(({ mode, ...row }) => ({ row, mode }));
}

export async function createCollection(
  store: ArtifactStore,
  actor: ArtifactActor,
  args: { name: string; purpose: string; columns?: unknown; guildId?: string | null },
): Promise<CollectionView> {
  assertOperator(actor);
  const name = validateCollectionName(args.name);
  const purpose = validatePurpose(args.purpose);
  const columns = parseColumns(args.columns ?? []);
  const guildId = args.guildId ? await requireGuild(store, actor, args.guildId) : null;
  if ((await countLiveCollections(store.db, actor.orgId)) >= LIVE_COLLECTIONS_MAX) {
    throw new ArtifactError("collection limit reached", 422);
  }
  try {
    return await withTransaction(store.db, async (client) => {
      const created = await insertCollection(
        client,
        { org_id: actor.orgId, guild_id: guildId, name, purpose, columns },
        actor,
        new Date(),
      );
      const grants = guildId ? defaultGrants("guild", guildId) : defaultGrants("org", actor.orgId);
      await writeGrants(client, actor, { kind: "collection", id: created.id }, grants);
      return collectionView(created, "write", 0);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ArtifactError("collection already exists", 409);
    }
    throw error;
  }
}

/** Gives every live record the identity its unique column's value makes; refuses when values repeat. */
async function reindexIdentity(client: Queryable, collectionId: string, unique: CollectionColumn): Promise<void> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const updates: Array<[string, string]> = [];
  for (const row of await listLiveRecordBodies(client, collectionId)) {
    const value = row.content_json[unique.name];
    const identity = normalizeIdentity(unique, value);
    if (identity === null) {
      continue;
    }
    if (seen.has(identity)) {
      duplicates.add(String(value));
    }
    seen.add(identity);
    updates.push([row.id, identity]);
  }
  if (duplicates.size) {
    throw new ArtifactError(
      `column "${unique.name}" cannot be unique while live records repeat: ${[...duplicates].slice(0, 20).join(", ")}`,
      409,
    );
  }
  await clearRecordIdentities(client, collectionId);
  for (const [id, identity] of updates) {
    await setRecordIdentity(client, id, identity);
  }
}

/** Whether the unique column the change leaves differs from the one the collection had, so identities are recomputed. */
function uniqueChanged(
  previous: CollectionColumn | null,
  next: CollectionColumn,
  renamed: Array<{ from: string; to: string }>,
): boolean {
  return (
    !previous ||
    previous.name !== next.name ||
    previous.type !== next.type ||
    renamed.some((item) => item.to === next.name)
  );
}

/** Applies a column change to the live records: renamed keys move, removed keys go, identities follow the unique column. */
async function applyColumnChange(
  client: Queryable,
  current: CollectionQueryRow,
  change: NonNullable<ReturnType<typeof parseColumnChange>>,
): Promise<void> {
  for (const rename of change.renamed) {
    await renameRecordKey(client, current.id, rename);
  }
  for (const removed of change.removed) {
    await dropRecordKey(client, current.id, removed);
  }
  const unique = uniqueColumn(change.columns);
  if (!unique) {
    await clearRecordIdentities(client, current.id);
  } else if (uniqueChanged(uniqueColumn(current.columns), unique, change.renamed)) {
    await reindexIdentity(client, current.id, unique);
  }
  if (change.renamed.length || change.removed.length) {
    await refreshRecordSearchBlobs(client, current.id);
  }
}

/**
 * Replaces a collection's name, purpose, owner, or columns. A column
 * change is applied to the live records in the same transaction: a
 * renamed column moves its key, a removed column drops it, and a column
 * that becomes unique is refused while live records repeat a value.
 * The owner is placement only: moving a table leaves its access list as it is.
 */
export async function updateCollection(
  store: ArtifactStore,
  actor: ArtifactActor,
  collectionId: string,
  args: CollectionChanges,
): Promise<CollectionView> {
  assertOperator(actor);
  const current = await loadCollectionById(store, actor, collectionId);
  if (!current) {
    throw new ArtifactError("unknown collection", 404);
  }
  const change = args.columns === undefined ? null : parseColumnChange(current.columns, args.columns);
  const patch = {
    id: current.id,
    name: args.name === undefined ? current.name : validateCollectionName(args.name),
    purpose: args.purpose === undefined ? current.purpose : validatePurpose(args.purpose),
    columns: change ? change.columns : current.columns,
    guild_id: await changedGuild(store, actor, current, args.guildId),
  };
  await withTransaction(store.db, async (client) => {
    await lockCollection(client, current.id);
    if (change) {
      await recordChangeIfAny(client, actor, collectionColumnsChanged(collectionRef(current), change));
      await applyColumnChange(client, current, change);
    }
    try {
      await writeCollection(client, patch, new Date());
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ArtifactError("collection already exists", 409);
      }
      throw error;
    }
  });
  const updated = await loadCollectionById(store, actor, current.id);
  if (!updated) {
    throw new ArtifactError("unknown collection", 404);
  }
  return collectionView(updated, "write", await countLiveRecords(store.db, updated.id));
}

/** The guild a collection's update leaves it with: its own when the update names none, null for an organisation table. */
async function changedGuild(
  store: ArtifactStore,
  actor: ArtifactActor,
  current: CollectionQueryRow,
  guildId: string | null | undefined,
): Promise<string | null> {
  if (guildId === undefined) {
    return current.guild_id;
  }
  return guildId ? requireGuild(store, actor, guildId) : null;
}

/** Soft-deletes a collection with every record in it and drops its access list. */
export async function deleteCollection(store: ArtifactStore, actor: ArtifactActor, collectionId: string): Promise<void> {
  assertOperator(actor);
  const collection = await loadCollectionById(store, actor, collectionId);
  if (!collection) {
    throw new ArtifactError("unknown collection", 404);
  }
  await withTransaction(store.db, async (client) => {
    await softDeleteCollection(client, collection.id, actor, new Date());
    await deleteAccessList(client, { kind: "collection", id: collection.id });
    await recordConfigChange(client, actor, collectionDeleted(collectionRef(collection)));
  });
}

/**
 * Soft-deletes every live record. The collection, its access list, and `next_id`
 * stay, so later inserts keep numbering from where the table left off.
 */
export async function clearRecords(store: ArtifactStore, actor: ArtifactActor, collectionId: string): Promise<number> {
  assertOperator(actor);
  const collection = await loadCollectionById(store, actor, collectionId);
  if (!collection) {
    throw new ArtifactError("unknown collection", 404);
  }
  return withTransaction(store.db, async (client) => {
    if ((await lockLiveCollection(client, collection.id)) === null) {
      throw new ArtifactError("unknown collection", 404);
    }
    const removed = await softDeleteRecords(client, collection.id, actor, new Date());
    await recordChangeIfAny(client, actor, collectionCleared(collectionRef(collection), removed));
    return removed;
  });
}

/**
 * The live collections the actor can read, with the actor's access mode.
 * The operator sees every collection in the organisation.
 */
export async function listCollections(store: ArtifactStore, actor: ArtifactActor): Promise<CollectionView[]> {
  const rows = await accessibleCollections(store, actor);
  return rows.map((item) => collectionView(item.row, item.mode));
}

/** `listCollections` with each collection's live record count. */
export async function listCollectionsWithCounts(store: ArtifactStore, actor: ArtifactActor): Promise<CollectionView[]> {
  const rows = await accessibleCollections(store, actor);
  const counts = await countLiveRecordsByCollection(store.db, rows.map((item) => item.row.id));
  return rows.map((item) => collectionView(item.row, item.mode, counts.get(item.row.id) ?? 0));
}

/** The State catalog: name, purpose, access, display path, and columns; capped. */
export async function collectionCatalog(
  store: ArtifactStore,
  actor: ArtifactActor,
  limit = STATE_COLLECTIONS_MAX,
): Promise<Array<Record<string, unknown>>> {
  const rows = await accessibleCollections(store, actor);
  const items: Array<Record<string, unknown>> = rows.slice(0, limit).map((item) => ({
    name: item.row.name,
    purpose: item.row.purpose,
    access: item.mode,
    scope: item.row.guild_id ? "guild" : "org",
    display_path: collectionDisplayPath(item.row.org_id, item.row.name),
    columns: columnCatalog(item.row.columns),
  }));
  if (rows.length > limit) {
    items.push({ truncated: true, name: "…", purpose: "more collections exist", access: "read", scope: "org", display_path: "", columns: [] });
  }
  return items;
}

export async function getCollection(store: ArtifactStore, actor: ArtifactActor, collectionId: string): Promise<CollectionView> {
  const collection = await loadCollectionById(store, actor, collectionId);
  const mode = collection ? await accessMode(store, actor, collection) : null;
  if (!collection || !mode) {
    throw new ArtifactError("unknown collection", 404);
  }
  return collectionView(collection, mode, await countLiveRecords(store.db, collection.id));
}

/** The collection by id when the actor reads it, or null. */
export async function readableCollectionById(
  store: ArtifactStore,
  actor: ArtifactActor,
  collectionId: string,
): Promise<CollectionQueryRow | null> {
  const collection = await loadCollectionById(store, actor, collectionId);
  return collection && (await accessMode(store, actor, collection)) ? collection : null;
}

/** The collection by name with the actor's access, or null when unknown or unreadable. */
export async function describeCollection(
  store: ArtifactStore,
  actor: ArtifactActor,
  name: string,
): Promise<CollectionDescription | null> {
  if (!COLLECTION_NAME_RE.test((name || "").trim())) {
    return null;
  }
  const collection = await loadCollectionByName(store, actor, validateCollectionName(name));
  const mode = collection ? await accessMode(store, actor, collection) : null;
  if (!collection || !mode) {
    return null;
  }
  return {
    id: collection.id,
    name: collection.name,
    purpose: collection.purpose,
    columns: collection.columns,
    guild_id: collection.guild_id,
    access: mode,
  };
}

export async function requireReadable(store: ArtifactStore, actor: ArtifactActor, name: string): Promise<CollectionDescription> {
  const described = await describeCollection(store, actor, name);
  if (!described) {
    throw new ArtifactError(`unknown collection ${String(name ?? "").trim() || "(empty)"}`, 404);
  }
  return described;
}

export async function requireWritable(store: ArtifactStore, actor: ArtifactActor, name: string): Promise<CollectionDescription> {
  const described = await requireReadable(store, actor, name);
  if (described.access !== "write") {
    throw new ArtifactError(`no write access to ${described.name}`, 403);
  }
  return described;
}

/**
 * What an empty search should say about a collection the actor can read:
 * how many records it holds, when the newest changed, and its columns.
 */
export async function collectionFacts(
  store: ArtifactStore,
  actor: ArtifactActor,
  name: string,
): Promise<{ name: string; count: number; newest_updated_at: string | null; columns: CollectionColumn[] } | null> {
  const described = await describeCollection(store, actor, name);
  if (!described) {
    return null;
  }
  const facts = await collectionRecordFacts(store.db, described.id);
  return {
    name: described.name,
    count: facts.count,
    newest_updated_at: facts.newest ? formatOperationalTimestamp(facts.newest) : null,
    columns: described.columns,
  };
}
