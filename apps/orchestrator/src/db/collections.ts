import type { InferSelectModel } from "drizzle-orm";
import type { ChangeActor } from "../lib/change-actor.js";
import { newId } from "../lib/ids.js";
import { agentModeSql, type ArtifactMode, type ArtifactReader } from "./artifact-access.js";
import { ARTIFACT_RETURNING, ARTIFACT_SELECT, type ArtifactOrTombstoneRow, type ArtifactRow } from "./artifacts.js";
import { RowMissing } from "./errors.js";
import { type Queryable, stamp } from "./pg.js";
import type { artifactCollections, artifacts, CollectionColumn, ColumnType, guilds, RecordBody } from "./schema/index.js";

type Collection = InferSelectModel<typeof artifactCollections>;
type Artifact = InferSelectModel<typeof artifacts>;

/** A record's row: an artifact of kind `object`, whose content is the record's body. */
export type RecordRow = Omit<ArtifactRow, "content_json"> & { content_json: RecordBody };

/** A collection as stored, with the name of the guild it belongs to. */
export type CollectionQueryRow = Pick<
  Collection,
  "id" | "org_id" | "guild_id" | "name" | "purpose" | "columns" | "next_id" | "created_by_name" | "created_at" | "updated_at"
> & { guild_name: InferSelectModel<typeof guilds>["name"] | null };

/** A new collection: its organisation, the guild it belongs to, its name, purpose, and columns. */
export type NewCollection = Pick<Collection, "org_id" | "guild_id" | "name" | "purpose"> & { columns: CollectionColumn[] };

/** What a collection's update writes: its name, purpose, owner, and columns. */
export type CollectionPatch = Pick<Collection, "id" | "guild_id" | "name" | "purpose"> & { columns: CollectionColumn[] };

/** A new record of a collection, written by a reader from its guild. */
export type NewRecord = Pick<Artifact, "org_id" | "origin_guild_id" | "collection_id" | "key" | "content_hash" | "search_blob" | "identity"> & {
  body: RecordBody;
};

/** A record's new body, the search text and identity it carries, and its hash. */
export type RecordUpdate = Pick<Artifact, "id" | "content_hash" | "search_blob" | "identity"> & {
  body: RecordBody;
};

/** One `where` term of a record listing or search, over a column or the record id. */
export type WhereClause =
  | { column: "id"; op: "id"; id: number }
  | { column: string; type: ColumnType; op: "null" }
  | { column: string; type: "text"; op: "like"; term: string }
  | { column: string; type: "text"; op: "eq"; term: string }
  | { column: string; type: "number"; op: "eq"; term: number }
  | { column: string; type: "number"; op: "range"; gte: number | null; lte: number | null }
  | { column: string; type: "datetime"; op: "eq"; term: string }
  | { column: string; type: "datetime"; op: "range"; gte: string | null; lte: string | null }
  | { column: string; type: "boolean"; op: "eq"; term: boolean }
  | { column: string; type: "array"; op: "like"; term: string }
  | { column: string; type: "array"; op: "contains"; term: string };

export type OrderClause = { column: string; direction: "asc" | "desc" };

/**
 * Lowest `word_similarity` that still counts as similar spelling. Below 0.5
 * any two words sharing their first two letters qualify, because pg_trgm
 * pads a word with two leading spaces.
 */
export const FUZZY_THRESHOLD = 0.5;

/** Whether a query is one token, which also matches by substring. */
export function isSingleToken(query: string): boolean {
  return query.length > 0 && !/\s/.test(query);
}

/**
 * Similar-spelling matches are for words and names. A term with a digit is
 * an identifier (date, hash, address, version) where neighbouring values
 * look alike, so it matches by substring only.
 */
export function allowsSimilarSpelling(term: string): boolean {
  return !/\d/.test(term);
}

const ISO_DATETIME_SQL_RE = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$`;

export const COLLECTION_SELECT = `
  artifact_collections.id, artifact_collections.org_id, artifact_collections.guild_id,
  (SELECT g.name FROM guilds g WHERE g.id = artifact_collections.guild_id) AS guild_name,
  artifact_collections.name,
  artifact_collections.purpose, artifact_collections.columns, artifact_collections.next_id,
  artifact_collections.created_by_name, artifact_collections.created_at, artifact_collections.updated_at
`;

export async function countLiveCollections(db: Queryable, orgId: string): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM artifact_collections WHERE org_id = $1 AND deleted_at IS NULL`,
    [orgId],
  );
  return result.rows[0]?.n ?? 0;
}

export async function insertCollection(
  db: Queryable,
  collection: NewCollection,
  actor: ChangeActor,
  now: Date,
): Promise<CollectionQueryRow> {
  const result = await db.query<CollectionQueryRow>(
    `INSERT INTO artifact_collections (
       id, org_id, guild_id, name, purpose, columns, next_id,
       created_by_type, created_by_id, created_by_name, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6::json,1,$7,$8,$9,$10,$10)
     RETURNING ${COLLECTION_SELECT}`,
    [
      newId("acol"),
      collection.org_id,
      collection.guild_id,
      collection.name,
      collection.purpose,
      JSON.stringify(collection.columns),
      actor.actorType,
      actor.actorId,
      actor.actorName,
      stamp(now),
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new RowMissing("collection insert returned no row");
  }
  return row;
}

/** Locks a collection's row for the rest of the transaction `db` runs. */
export async function lockCollection(db: Queryable, collectionId: string): Promise<void> {
  await db.query(`SELECT id FROM artifact_collections WHERE id = $1 FOR UPDATE`, [collectionId]);
}

/** A live collection's next record id, locked for the rest of the transaction; null when it is not live. */
export async function lockLiveCollection(db: Queryable, collectionId: string): Promise<number | null> {
  const result = await db.query<{ next_id: number }>(
    `SELECT next_id FROM artifact_collections WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [collectionId],
  );
  return result.rows[0]?.next_id ?? null;
}

/** A record key's rename: the key it had and the key it takes. */
export type RecordKeyRename = { from: string; to: string };

/** Moves the value of one key of every live record to another key. */
export async function renameRecordKey(
  db: Queryable,
  collectionId: string,
  rename: RecordKeyRename,
): Promise<void> {
  await db.query(
    `UPDATE artifacts
        SET content_json = (content_json - $2::text) || jsonb_build_object($3::text, content_json -> $2::text)
      WHERE collection_id = $1 AND kind = 'object' AND deleted_at IS NULL AND content_json ? $2::text`,
    [collectionId, rename.from, rename.to],
  );
}

/** Drops one key from every live record. */
export async function dropRecordKey(db: Queryable, collectionId: string, key: string): Promise<void> {
  await db.query(
    `UPDATE artifacts SET content_json = content_json - $2::text
      WHERE collection_id = $1 AND kind = 'object' AND deleted_at IS NULL AND content_json ? $2::text`,
    [collectionId, key],
  );
}

/** Clears the identity every record of the collection carries. */
export async function clearRecordIdentities(db: Queryable, collectionId: string): Promise<void> {
  await db.query(
    `UPDATE artifacts SET identity = NULL WHERE collection_id = $1 AND kind = 'object' AND identity IS NOT NULL`,
    [collectionId],
  );
}

/** The id, key, and body of every live record, for recomputing their identities. */
export async function listLiveRecordBodies(
  db: Queryable,
  collectionId: string,
): Promise<Array<Pick<RecordRow, "id" | "key" | "content_json">>> {
  const result = await db.query<Pick<RecordRow, "id" | "key" | "content_json">>(
    `SELECT id, key, content_json FROM artifacts
      WHERE collection_id = $1 AND kind = 'object' AND deleted_at IS NULL`,
    [collectionId],
  );
  return result.rows;
}

export async function setRecordIdentity(db: Queryable, recordId: string, identity: string): Promise<void> {
  await db.query(`UPDATE artifacts SET identity = $2 WHERE id = $1`, [recordId, identity]);
}

/** Rebuilds the search text of every live record from its key and values. */
export async function refreshRecordSearchBlobs(db: Queryable, collectionId: string): Promise<void> {
  await db.query(
    `UPDATE artifacts a
        SET search_blob = left(a.key || COALESCE((
                SELECT ' ' || string_agg(t.v, ' ' ORDER BY t.k)
                  FROM jsonb_each_text(a.content_json) AS t(k, v)
                 WHERE t.v IS NOT NULL AND btrim(t.v) <> ''), ''), 32768)
      WHERE a.collection_id = $1 AND a.kind = 'object' AND a.deleted_at IS NULL`,
    [collectionId],
  );
}

export async function updateCollection(db: Queryable, patch: CollectionPatch, now: Date): Promise<void> {
  await db.query(
    `UPDATE artifact_collections SET name = $2, purpose = $3, columns = $4::json, guild_id = $5, updated_at = $6
      WHERE id = $1 AND deleted_at IS NULL`,
    [patch.id, patch.name, patch.purpose, JSON.stringify(patch.columns), patch.guild_id, stamp(now)],
  );
}

/** Soft-deletes a collection and every live artifact in it. */
export async function softDeleteCollection(
  db: Queryable,
  collectionId: string,
  actor: ChangeActor,
  now: Date,
): Promise<void> {
  await db.query(
    `UPDATE artifacts SET deleted_at = $2, updated_by_type = $3, updated_by_id = $4, updated_by_name = $5, updated_at = $2
      WHERE collection_id = $1 AND deleted_at IS NULL`,
    [collectionId, stamp(now), actor.actorType, actor.actorId, actor.actorName],
  );
  await db.query(
    `UPDATE artifact_collections SET deleted_at = $2, updated_at = $2 WHERE id = $1 AND deleted_at IS NULL`,
    [collectionId, stamp(now)],
  );
}

/** Soft-deletes every live record of a collection; returns how many. */
export async function softDeleteRecords(
  db: Queryable,
  collectionId: string,
  actor: ChangeActor,
  now: Date,
): Promise<number> {
  const result = await db.query(
    `UPDATE artifacts
        SET deleted_at = $2, updated_by_type = $3, updated_by_id = $4, updated_by_name = $5, updated_at = $2
      WHERE collection_id = $1 AND kind = 'object' AND deleted_at IS NULL`,
    [collectionId, stamp(now), actor.actorType, actor.actorId, actor.actorName],
  );
  return result.rowCount ?? 0;
}

/** How many live records a collection holds, and when the newest changed. */
export async function collectionRecordFacts(
  db: Queryable,
  collectionId: string,
): Promise<{ count: number; newest: string | null }> {
  const result = await db.query<{ count: number; newest: string | null }>(
    `SELECT count(*)::int AS count, max(updated_at) AS newest
       FROM artifacts WHERE collection_id = $1 AND kind = 'object' AND deleted_at IS NULL`,
    [collectionId],
  );
  return result.rows[0] ?? { count: 0, newest: null };
}

export async function countLiveRecords(db: Queryable, collectionId: string): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM artifacts WHERE collection_id = $1 AND kind = 'object' AND deleted_at IS NULL`,
    [collectionId],
  );
  return result.rows[0]?.n ?? 0;
}

/** How many live records each of the collections holds. */
export async function countLiveRecordsByCollection(db: Queryable, ids: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!ids.length) {
    return counts;
  }
  const result = await db.query<{ collection_id: string; n: number }>(
    `SELECT collection_id, count(*)::int AS n FROM artifacts
      WHERE collection_id = ANY($1::text[]) AND kind = 'object' AND deleted_at IS NULL
      GROUP BY collection_id`,
    [ids],
  );
  for (const row of result.rows) {
    counts.set(row.collection_id, row.n);
  }
  return counts;
}

/** The live record holding `identity`, locked for the rest of the transaction; null when none does. */
export async function lockRecordByIdentity(
  db: Queryable,
  collectionId: string,
  identity: string,
): Promise<RecordRow | null> {
  const result = await db.query<RecordRow>(
    `SELECT ${ARTIFACT_SELECT}
       FROM artifacts a
       LEFT JOIN artifact_collections c ON c.id = a.collection_id
      WHERE a.collection_id = $1 AND a.kind = 'object' AND a.deleted_at IS NULL AND a.identity = $2
      FOR UPDATE OF a
      LIMIT 1`,
    [collectionId, identity],
  );
  return result.rows[0] ?? null;
}

/** The key of another live record holding `identity`; null when none does. */
export async function getOtherRecordKey(
  db: Queryable,
  collectionId: string,
  identity: string,
  exceptId: string,
): Promise<string | null> {
  const result = await db.query<{ key: string }>(
    `SELECT key FROM artifacts
      WHERE collection_id = $1 AND kind = 'object' AND deleted_at IS NULL AND identity = $2 AND id <> $3
      LIMIT 1`,
    [collectionId, identity, exceptId],
  );
  return result.rows[0]?.key ?? null;
}

export async function insertRecord(
  db: Queryable,
  record: NewRecord,
  actor: ChangeActor,
  now: Date,
): Promise<RecordRow> {
  const result = await db.query<RecordRow>(
    `INSERT INTO artifacts (
       id, org_id, level, owner_id, guild_id, agent_id, origin_guild_id, kind,
       collection_id, path, key, title, content_text, content_json, search_text,
       content_hash, version,
       created_by_type, created_by_id, created_by_name,
       updated_by_type, updated_by_id, updated_by_name, created_at, updated_at,
       search_blob, identity
     ) VALUES (
       $1,$2,'org',$2,NULL,NULL,$3,'object',
       $4,'',$5,NULL,NULL,$6::jsonb,NULL,
       $7,1,
       $8,$9,$10,$8,$9,$10,$11,$11,
       $12,$13
     )
     RETURNING ${ARTIFACT_RETURNING}`,
    [
      newId("art"),
      record.org_id,
      record.origin_guild_id,
      record.collection_id,
      record.key,
      JSON.stringify(record.body),
      record.content_hash,
      actor.actorType,
      actor.actorId,
      actor.actorName,
      stamp(now),
      record.search_blob,
      record.identity,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new RowMissing("record insert returned no row");
  }
  return row;
}

export async function setCollectionNextId(db: Queryable, collectionId: string, nextId: number): Promise<void> {
  await db.query(`UPDATE artifact_collections SET next_id = $2 WHERE id = $1`, [collectionId, nextId]);
}

export async function updateRecordBody(
  db: Queryable,
  record: RecordUpdate,
  actor: ChangeActor,
  now: Date,
): Promise<RecordRow> {
  const result = await db.query<RecordRow>(
    `UPDATE artifacts
        SET content_json = $2::jsonb, search_blob = $3, identity = $4, content_hash = $5, version = version + 1,
            updated_by_type = $6, updated_by_id = $7, updated_by_name = $8, updated_at = $9
      WHERE id = $1
      RETURNING ${ARTIFACT_RETURNING}`,
    [
      record.id,
      JSON.stringify(record.body),
      record.search_blob,
      record.identity,
      record.content_hash,
      actor.actorType,
      actor.actorId,
      actor.actorName,
      stamp(now),
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new RowMissing("record row vanished during its write");
  }
  return row;
}

/** A live record by its id in the collection; null when there is none. */
export async function getLiveRecord(db: Queryable, collectionId: string, id: number): Promise<RecordRow | null> {
  const result = await db.query<RecordRow>(
    `SELECT ${ARTIFACT_SELECT}
       FROM artifacts a
       LEFT JOIN artifact_collections c ON c.id = a.collection_id
      WHERE a.collection_id = $1 AND a.kind = 'object' AND a.key = $2 AND a.deleted_at IS NULL
      LIMIT 1`,
    [collectionId, String(id)],
  );
  return result.rows[0] ?? null;
}

/** A record by its id in the collection, the live one first, else its newest tombstone; null when there never was one. */
export async function getRecordOrTombstone(
  db: Queryable,
  collectionId: string,
  id: number,
): Promise<ArtifactOrTombstoneRow | null> {
  const result = await db.query<ArtifactOrTombstoneRow>(
    `SELECT ${ARTIFACT_SELECT}, a.deleted_at
       FROM artifacts a
       LEFT JOIN artifact_collections c ON c.id = a.collection_id
      WHERE a.collection_id = $1 AND a.kind = 'object' AND a.key = $2
      ORDER BY a.deleted_at NULLS FIRST
      LIMIT 1`,
    [collectionId, String(id)],
  );
  return result.rows[0] ?? null;
}

/** A live record locked for the rest of the transaction `db` runs; null when there is none. */
export async function lockLiveRecord(db: Queryable, collectionId: string, id: number): Promise<RecordRow | null> {
  const result = await db.query<RecordRow>(
    `SELECT ${ARTIFACT_SELECT}
       FROM artifacts a
       LEFT JOIN artifact_collections c ON c.id = a.collection_id
      WHERE a.collection_id = $1 AND a.kind = 'object' AND a.key = $2 AND a.deleted_at IS NULL
      FOR UPDATE OF a
      LIMIT 1`,
    [collectionId, String(id)],
  );
  return result.rows[0] ?? null;
}

export async function getCollectionById(
  db: Queryable,
  orgId: string,
  collectionId: string,
): Promise<CollectionQueryRow | null> {
  const result = await db.query<CollectionQueryRow>(
    `SELECT ${COLLECTION_SELECT} FROM artifact_collections WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [orgId, collectionId],
  );
  return result.rows[0] ?? null;
}

export async function getCollectionByName(
  db: Queryable,
  orgId: string,
  name: string,
): Promise<CollectionQueryRow | null> {
  const result = await db.query<CollectionQueryRow>(
    `SELECT ${COLLECTION_SELECT} FROM artifact_collections WHERE org_id = $1 AND name = $2 AND deleted_at IS NULL`,
    [orgId, name],
  );
  return result.rows[0] ?? null;
}

/** The organisation's live collections, by name, leaving out the own tables of `hiddenGuildIds`. */
export async function listOrgCollections(
  db: Queryable,
  orgId: string,
  hiddenGuildIds: readonly string[],
): Promise<CollectionQueryRow[]> {
  const result = await db.query<CollectionQueryRow>(
    `SELECT ${COLLECTION_SELECT} FROM artifact_collections
      WHERE org_id = $1 AND deleted_at IS NULL
        AND (guild_id IS NULL OR guild_id <> ALL($2::text[]))
      ORDER BY name`,
    [orgId, hiddenGuildIds],
  );
  return result.rows;
}

/** The live collections an agent's access lists let it read, by name, with the mode each gives. */
export async function listReachedCollections(
  db: Queryable,
  reader: ArtifactReader,
): Promise<Array<CollectionQueryRow & { mode: ArtifactMode }>> {
  const values: unknown[] = [reader.orgId];
  const mode = agentModeSql("collection", "artifact_collections.id", reader, values);
  const result = await db.query<CollectionQueryRow & { mode: ArtifactMode }>(
    `SELECT * FROM (
       SELECT ${COLLECTION_SELECT}, ${mode} AS mode
         FROM artifact_collections
        WHERE artifact_collections.org_id = $1 AND artifact_collections.deleted_at IS NULL
     ) reached
      WHERE reached.mode IN ('read', 'write')
      ORDER BY reached.name`,
    values,
  );
  return result.rows;
}

/** What a record listing reads: the `where` terms, a change cut-off, the order, and the page. */
export type RecordListing = {
  where: WhereClause[];
  since: string | null;
  order: OrderClause;
  limit: number;
  offset: number;
};

/** A collection by id with its declared columns, which order its records. */
export type CollectionShape = { id: string; columns: CollectionColumn[] };

/** One page of a collection's live records, and how many match in all. */
export async function listRecords(
  db: Queryable,
  collection: CollectionShape,
  listing: RecordListing,
): Promise<{ total: number; rows: RecordRow[] }> {
  const values: unknown[] = [collection.id];
  let filter = `a.collection_id = $1 AND a.kind = 'object' AND a.deleted_at IS NULL`;
  for (const clause of listing.where) {
    filter += ` AND ${whereClauseSql(clause, values).where}`;
  }
  if (listing.since) {
    values.push(listing.since);
    filter += ` AND a.updated_at >= $${values.length}`;
  }
  const total = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM artifacts a WHERE ${filter}`, values);
  const orderSql = orderClauseSql(listing.order, collection.columns, values);
  values.push(listing.limit);
  const limitIndex = values.length;
  values.push(listing.offset);
  const result = await db.query<RecordRow>(
    `SELECT ${ARTIFACT_SELECT}
       FROM artifacts a
       LEFT JOIN artifact_collections c ON c.id = a.collection_id
      WHERE ${filter}
      ORDER BY ${orderSql}
      LIMIT $${limitIndex} OFFSET $${values.length}`,
    values,
  );
  return { total: total.rows[0]?.n ?? 0, rows: result.rows };
}

/** What a record search reads: the query, the `where` terms of one collection, and a row cap. */
export type RecordSearch = { query: string; where: WhereClause[]; limit: number };

/**
 * Text search over live records, best first: within one collection, or over every collection the
 * reader can read when `collectionId` is null.
 */
export async function searchRecords(
  db: Queryable,
  reader: ArtifactReader,
  collectionId: string | null,
  search: RecordSearch,
): Promise<RecordRow[]> {
  const values: unknown[] = [];
  let scope: string;
  if (collectionId) {
    values.push(collectionId);
    scope = `a.collection_id = $1`;
  } else {
    scope = readableCollectionsSql(reader, values);
  }
  let sql = `SELECT ${ARTIFACT_SELECT}
       FROM artifacts a
       JOIN artifact_collections c ON c.id = a.collection_id AND c.deleted_at IS NULL
      WHERE a.kind = 'object' AND a.deleted_at IS NULL AND ${scope}`;
  const text = objectQuerySql(search.query, values);
  sql += ` AND ${text.where}`;
  const scores = [text.score];
  for (const clause of search.where) {
    const built = whereClauseSql(clause, values);
    sql += ` AND ${built.where}`;
    if (built.score) scores.push(built.score);
  }
  values.push(search.limit);
  sql += ` ORDER BY (${scores.join(" + ")}) DESC, a.updated_at DESC LIMIT $${values.length}`;
  const result = await db.query<RecordRow>(sql, values);
  return result.rows;
}

/** Up to `limit` live records of a collection, in id order. */
export async function listAllRecords(db: Queryable, collectionId: string, limit: number): Promise<RecordRow[]> {
  const result = await db.query<RecordRow>(
    `SELECT ${ARTIFACT_SELECT}
       FROM artifacts a
       LEFT JOIN artifact_collections c ON c.id = a.collection_id
      WHERE a.collection_id = $1 AND a.kind = 'object' AND a.deleted_at IS NULL
      ORDER BY length(a.key), a.key
      LIMIT $2`,
    [collectionId, limit],
  );
  return result.rows;
}

/** The predicate over `a.collection_id` for every collection the reader can read. */
function readableCollectionsSql(reader: ArtifactReader, values: unknown[]): string {
  values.push(reader.orgId);
  const org = values.length;
  if (reader.operator) {
    values.push(reader.hidden.guildIds);
    return `c.org_id = $${org} AND (c.guild_id IS NULL OR c.guild_id <> ALL($${values.length}::text[]))`;
  }
  return `c.org_id = $${org} AND ${agentModeSql("collection", "a.collection_id", reader, values)} IN ('read', 'write')`;
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Substring match of `term` on `expr`; with `similar`, a term without digits
 * also matches similar spelling. The score is the term's best word
 * similarity, used for ranking either way.
 */
function fuzzySql(
  term: string,
  expr: string,
  values: unknown[],
  similar: boolean,
): { where: string; score: string } {
  values.push(term);
  const t = values.length;
  values.push(`%${escapeLike(term)}%`);
  const like = values.length;
  const widen =
    similar && allowsSimilarSpelling(term) ? ` OR word_similarity($${t}, ${expr}) >= ${FUZZY_THRESHOLD}` : "";
  return {
    where: `(${expr} ILIKE $${like}${widen})`,
    score: `word_similarity($${t}, ${expr})`,
  };
}

function arrayItemsExpr(column: number): string {
  return `jsonb_array_elements_text(CASE WHEN jsonb_typeof(a.content_json -> $${column}) = 'array' THEN a.content_json -> $${column} ELSE '[]'::jsonb END)`;
}

/** The open-text predicate, applied to each item of an array column. */
function fuzzyArraySql(term: string, column: number, values: unknown[]): { where: string; score: string } {
  const items = arrayItemsExpr(column);
  const match = fuzzySql(term, "item", values, true);
  return {
    where: `EXISTS (SELECT 1 FROM ${items} AS item WHERE ${match.where})`,
    score: `COALESCE((SELECT MAX(${match.score}) FROM ${items} AS item), 0)`,
  };
}

/**
 * Predicate and score for a free-text record query: whole words through the
 * tsvector (`websearch` grammar); a single token also matches the value text
 * by substring. Similar spelling is not applied here: against a whole
 * record's text a short token would match too many neighbours.
 */
function objectQuerySql(query: string, values: unknown[]): { where: string; score: string } {
  values.push(query);
  const q = values.length;
  const tsquery = `websearch_to_tsquery('simple', $${q})`;
  const where = `a.search_document @@ ${tsquery}`;
  const score = `ts_rank_cd(a.search_document, ${tsquery})`;
  if (!isSingleToken(query)) {
    return { where, score };
  }
  const partial = fuzzySql(query, "a.search_blob", values, false);
  return { where: `(${where} OR ${partial.where})`, score: `(${score} + ${partial.score})` };
}

function numberExpr(column: number): string {
  return `(CASE WHEN jsonb_typeof(a.content_json -> $${column}) = 'number' THEN (a.content_json ->> $${column})::numeric END)`;
}

function datetimeExpr(column: number): string {
  return `(CASE WHEN (a.content_json ->> $${column}) ~ '${ISO_DATETIME_SQL_RE}' THEN (a.content_json ->> $${column})::timestamptz END)`;
}

/** One `where` term as SQL over the record body. */
function whereClauseSql(clause: WhereClause, values: unknown[]): { where: string; score: string | null } {
  if (clause.op === "id") {
    values.push(String(clause.id));
    return { where: `a.key = $${values.length}`, score: null };
  }
  values.push(clause.column);
  const column = values.length;
  if (clause.op === "null") {
    return { where: `COALESCE(a.content_json -> $${column}, 'null'::jsonb) = 'null'::jsonb`, score: null };
  }
  if (clause.type === "text") {
    if (clause.op === "like") {
      return fuzzySql(clause.term, `COALESCE(a.content_json ->> $${column}, '')`, values, true);
    }
    values.push(clause.term);
    return { where: `a.content_json ->> $${column} = $${values.length}`, score: null };
  }
  if (clause.type === "array") {
    if (clause.op === "like") {
      return fuzzyArraySql(clause.term, column, values);
    }
    values.push(JSON.stringify([clause.term]));
    return { where: `a.content_json -> $${column} @> $${values.length}::jsonb`, score: null };
  }
  if (clause.type === "boolean") {
    values.push(JSON.stringify(clause.term));
    return { where: `a.content_json -> $${column} = $${values.length}::jsonb`, score: null };
  }
  if (clause.type === "number") {
    return numberClauseSql(clause, column, values);
  }
  return datetimeClauseSql(clause, column, values);
}

/** A `where` term over a number column. */
type NumberWhereClause = Extract<WhereClause, { type: "number" }>;

function numberClauseSql(
  clause: NumberWhereClause,
  column: number,
  values: unknown[],
): { where: string; score: null } {
  if (clause.op === "eq") {
    values.push(clause.term);
    return { where: `${numberExpr(column)} = $${values.length}::numeric`, score: null };
  }
  const parts: string[] = [];
  if (clause.gte !== null) {
    values.push(clause.gte);
    parts.push(`${numberExpr(column)} >= $${values.length}::numeric`);
  }
  if (clause.lte !== null) {
    values.push(clause.lte);
    parts.push(`${numberExpr(column)} <= $${values.length}::numeric`);
  }
  return { where: `(${parts.join(" AND ")})`, score: null };
}

/** A `where` term over a datetime column. */
type DatetimeWhereClause = Extract<WhereClause, { type: "datetime" }>;

function datetimeClauseSql(
  clause: DatetimeWhereClause,
  column: number,
  values: unknown[],
): { where: string; score: null } {
  if (clause.op === "eq") {
    values.push(clause.term);
    return { where: `${datetimeExpr(column)} = $${values.length}::timestamptz`, score: null };
  }
  const parts: string[] = [];
  if (clause.gte !== null) {
    values.push(clause.gte);
    parts.push(`${datetimeExpr(column)} >= $${values.length}::timestamptz`);
  }
  if (clause.lte !== null) {
    values.push(clause.lte);
    parts.push(`${datetimeExpr(column)} <= $${values.length}::timestamptz`);
  }
  return { where: `(${parts.join(" AND ")})`, score: null };
}

/** The ORDER BY for a listing: a declared column by its type, or a system column; id order breaks ties. */
function orderClauseSql(order: OrderClause, columns: CollectionColumn[], values: unknown[]): string {
  const direction = order.direction === "desc" ? "DESC" : "ASC";
  const nulls = order.direction === "desc" ? "NULLS LAST" : "NULLS FIRST";
  const byId = `length(a.key) ${direction}, a.key ${direction}`;
  if (order.column === "id") {
    return byId;
  }
  if (order.column === "created_at" || order.column === "updated_at") {
    return `a.${order.column} ${direction}, ${byId}`;
  }
  const column = columns.find((item) => item.name === order.column);
  if (!column) {
    return byId;
  }
  values.push(column.name);
  const index = values.length;
  const expr =
    column.type === "number"
      ? numberExpr(index)
      : column.type === "boolean"
        ? `a.content_json -> $${index}`
        : `a.content_json ->> $${index}`;
  return `${expr} ${direction} ${nulls}, ${byId}`;
}
