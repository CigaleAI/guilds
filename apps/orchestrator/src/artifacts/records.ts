import { softDeleteArtifact } from "../db/artifacts.js";
import {
  countLiveRecords,
  getLiveRecord,
  getOtherRecordKey,
  insertRecord,
  listAllRecords,
  listRecords as listRecordRows,
  lockLiveCollection,
  lockLiveRecord,
  lockRecordByIdentity,
  searchRecords as searchRecordRows,
  setCollectionNextId,
  updateRecordBody,
  type RecordRow,
  type WhereClause,
} from "../db/collections.js";
import { recordFileChange } from "../db/file-changes.js";
import { isUniqueViolation, type Queryable, withTransaction } from "../db/pg.js";
import type { CollectionColumn, RecordBody } from "../db/schema/index.js";
import { readableCollectionById, requireReadable, requireWritable } from "./collections.js";
import { identityFor, recordProblems, recordRejected, uniqueColumn, validateAdd, validatePatch } from "./columns.js";
import { ArtifactError } from "./errors.js";
import { parseLimit, parseOffset, parseOrder, parseRecordId, parseSince, parseWhere, searchBlobFor } from "./search.js";
import { assertBytes, bodyOf, hashArtifactContent, recordView, type ArtifactStore, type CollectionDescription, type RecordView, rowDisplayPath } from "./store.js";
import { FIND_DEFAULT, FIND_MAX, LIVE_RECORDS_MAX, type ArtifactActor } from "./types.js";

function uniqueConflictMessage(columns: CollectionColumn[]): string {
  const unique = uniqueColumn(columns);
  return unique ? `another record already holds that ${unique.name}` : "record already exists";
}

function problemColumn(problem: string): string {
  const match = /^column "([^"]+)"/.exec(problem);
  return match?.[1] ?? "";
}

/** A record's live row by id, locked; a 404 when there is none. */
async function lockRecord(client: Queryable, collectionId: string, id: number): Promise<RecordRow> {
  const row = await lockLiveRecord(client, collectionId, id);
  if (!row) {
    throw new ArtifactError(`record ${id} not found`, 404);
  }
  return row;
}

/** Writes a record's merged body and logs the update against `actor`; a value its unique column already holds is a 409. */
async function writeRecordBody(
  client: Queryable,
  actor: ArtifactActor,
  collection: CollectionDescription,
  record: { current: RecordRow; body: RecordBody; identity: string | null },
): Promise<RecordRow> {
  const { current, body, identity } = record;
  let row: RecordRow;
  try {
    row = await updateRecordBody(
      client,
      {
        id: current.id,
        body,
        search_blob: searchBlobFor(current.key, body),
        identity,
        content_hash: hashArtifactContent(null, body),
      },
      actor,
      new Date(),
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ArtifactError(uniqueConflictMessage(collection.columns), 409);
    }
    throw error;
  }
  const written = { ...row, collection_name: collection.name };
  await recordFileChange(client, actor, {
    orgId: written.org_id,
    artifactId: written.id,
    displayPath: rowDisplayPath(written),
    operation: "update",
    version: written.version,
  });
  return written;
}

/** Inserts a new record with the collection's next id and logs its creation against `actor`. */
async function insertNewRecord(
  client: Queryable,
  actor: ArtifactActor,
  collection: CollectionDescription,
  record: { nextId: number; body: RecordBody; identity: string | null },
): Promise<RecordRow> {
  if ((await countLiveRecords(client, collection.id)) >= LIVE_RECORDS_MAX) {
    throw new ArtifactError("record limit reached", 422);
  }
  const key = String(record.nextId);
  let row: RecordRow;
  try {
    row = await insertRecord(
      client,
      {
        org_id: actor.orgId,
        origin_guild_id: actor.guildId,
        collection_id: collection.id,
        key,
        body: record.body,
        content_hash: hashArtifactContent(null, record.body),
        search_blob: searchBlobFor(key, record.body),
        identity: record.identity,
      },
      actor,
      new Date(),
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ArtifactError(uniqueConflictMessage(collection.columns), 409);
    }
    throw error;
  }
  await setCollectionNextId(client, collection.id, record.nextId + 1);
  const written = { ...row, collection_name: collection.name };
  await recordFileChange(client, actor, {
    orgId: written.org_id,
    artifactId: written.id,
    displayPath: rowDisplayPath(written),
    operation: "create",
    version: written.version,
  });
  return written;
}

/**
 * Adds a record. The body is validated against the columns and rejected
 * with every problem at once; the store assigns the id. When the unique
 * column matches a live record, the body is merged into that record
 * instead and `merged` carries its id.
 */
export async function addRecord(
  store: ArtifactStore,
  actor: ArtifactActor,
  args: { collection: string; body: Record<string, unknown> },
): Promise<{ record: RecordView; merged: number | null }> {
  const collection = await requireWritable(store, actor, args.collection);
  const checked = validateAdd(collection.columns, args.body);
  if (checked.problems.length) {
    throw recordRejected(checked.problems);
  }
  const body = checked.body;
  assertBytes(JSON.stringify(body));
  const identity = identityFor(collection.columns, body);
  return withTransaction(store.db, async (client) => {
    const nextId = await lockLiveCollection(client, collection.id);
    if (nextId === null) {
      throw new ArtifactError("unknown collection", 404);
    }
    const current = identity === null ? null : await lockRecordByIdentity(client, collection.id, identity);
    if (current) {
      const merged = { ...bodyOf(current), ...body };
      const row = await writeRecordBody(client, actor, collection, { current, body: merged, identity });
      return { record: recordView(row), merged: Number(row.key) };
    }
    const row = await insertNewRecord(client, actor, collection, { nextId, body, identity });
    return { record: recordView(row), merged: null };
  });
}

/**
 * Merges a patch into a record. The patched columns are validated; the
 * rest of the record is checked afterwards and its pre-existing problems
 * are returned as warnings without rejecting the write.
 */
export async function updateRecord(
  store: ArtifactStore,
  actor: ArtifactActor,
  args: { collection: string; id: unknown; body: Record<string, unknown> },
): Promise<{ record: RecordView; warnings: string[] }> {
  const collection = await requireWritable(store, actor, args.collection);
  const id = parseRecordId(args.id);
  const checked = validatePatch(collection.columns, args.body);
  if (checked.problems.length) {
    throw recordRejected(checked.problems);
  }
  return withTransaction(store.db, async (client) => {
    const current = await lockRecord(client, collection.id, id);
    const merged: RecordBody = { ...bodyOf(current) };
    for (const name of checked.clear) {
      delete merged[name];
    }
    Object.assign(merged, checked.set);
    assertBytes(JSON.stringify(merged));
    const identity = identityFor(collection.columns, merged);
    const clash = identity === null ? null : await getOtherRecordKey(client, collection.id, identity, current.id);
    if (clash) {
      throw new ArtifactError(`${uniqueConflictMessage(collection.columns)}: record ${clash} already holds that value`, 409);
    }
    const row = await writeRecordBody(client, actor, collection, { current, body: merged, identity });
    const touched = new Set([...Object.keys(checked.set), ...checked.clear]);
    const warnings = recordProblems(collection.columns, merged).filter((problem) => !touched.has(problemColumn(problem)));
    return { record: recordView(row), warnings };
  });
}

export async function removeRecord(
  store: ArtifactStore,
  actor: ArtifactActor,
  args: { collection: string; id: unknown },
): Promise<number> {
  const collection = await requireWritable(store, actor, args.collection);
  const id = parseRecordId(args.id);
  return withTransaction(store.db, async (client) => {
    const current = await lockRecord(client, collection.id, id);
    const now = new Date();
    const version = await softDeleteArtifact(client, current.id, actor, now);
    if (version === null) {
      throw new ArtifactError("record not found", 404);
    }
    await recordFileChange(client, actor, {
      orgId: current.org_id,
      artifactId: current.id,
      displayPath: rowDisplayPath(current),
      operation: "delete",
      version,
      createdAt: now,
    });
    return id;
  });
}

export async function getRecord(
  store: ArtifactStore,
  actor: ArtifactActor,
  collectionName: string,
  id: unknown,
): Promise<RecordView> {
  const collection = await requireReadable(store, actor, collectionName);
  const row = await getLiveRecord(store.db, collection.id, parseRecordId(id));
  if (!row) {
    throw new ArtifactError("record not found", 404);
  }
  return recordView(row);
}

/**
 * Records of one collection narrowed by `where` (a term per column, matched
 * by the column's type), `since` (changed at or after a moment), ordered
 * by `order` (default id; with `since`, default oldest change first), and
 * paged by `limit` and `offset`. `total` counts every match regardless of
 * paging.
 */
export async function listRecords(
  store: ArtifactStore,
  actor: ArtifactActor,
  args: { collection: string; where?: unknown; since?: unknown; order?: unknown; limit?: unknown; offset?: unknown },
): Promise<{ total: number; records: RecordView[]; columns: CollectionColumn[] }> {
  const collection = await requireReadable(store, actor, args.collection);
  const since = parseSince(args.since);
  const order =
    parseOrder(args.order, collection.columns) ??
    (since ? { column: "updated_at", direction: "asc" as const } : { column: "id", direction: "asc" as const });
  const listed = await listRecordRows(store.db, collection, {
    where: parseWhere(args.where, collection.columns),
    since,
    order,
    limit: parseLimit(args.limit, FIND_DEFAULT, FIND_MAX),
    offset: parseOffset(args.offset),
  });
  return { total: listed.total, records: listed.rows.map(recordView), columns: collection.columns };
}

/**
 * Text search over the records the actor can read: whole words through
 * the tsvector with the websearch grammar, a single token also by
 * substring. With `collection`, `where` narrows the hits by column.
 */
export async function searchRecords(
  store: ArtifactStore,
  actor: ArtifactActor,
  args: { collection?: string; query: string; where?: unknown; limit?: unknown },
): Promise<{ records: RecordView[] }> {
  const query = (args.query ?? "").trim();
  if (!query) {
    throw new ArtifactError("query is required", 422);
  }
  const limit = parseLimit(args.limit, FIND_DEFAULT, FIND_MAX);
  if (!args.collection && args.where !== undefined && args.where !== null) {
    throw new ArtifactError("where needs a collection", 422);
  }
  const collection = args.collection ? await requireReadable(store, actor, args.collection) : null;
  const where: WhereClause[] = collection ? parseWhere(args.where, collection.columns) : [];
  const rows = await searchRecordRows(store.db, actor, collection?.id ?? null, { query, where, limit });
  return { records: rows.map(recordView) };
}

/** Every live record of a collection, in id order, for an export. */
export async function exportRecords(
  store: ArtifactStore,
  actor: ArtifactActor,
  collectionId: string,
): Promise<{ name: string; records: RecordView[] }> {
  const collection = await readableCollectionById(store, actor, collectionId);
  if (!collection) {
    throw new ArtifactError("unknown collection", 404);
  }
  const rows = await listAllRecords(store.db, collection.id, LIVE_RECORDS_MAX);
  return { name: collection.name, records: rows.map(recordView) };
}
