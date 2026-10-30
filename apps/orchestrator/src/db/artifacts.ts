import type { InferSelectModel } from "drizzle-orm";
import type { ChangeActor } from "../lib/change-actor.js";
import { newId } from "../lib/ids.js";
import { agentModeSql, type ArtifactMode, type ArtifactReader } from "./artifact-access.js";
import { RowMissing } from "./errors.js";
import { type Queryable, stamp } from "./pg.js";
import type { artifactCollections, artifacts, memoryRevisions } from "./schema/index.js";

type Artifact = InferSelectModel<typeof artifacts>;

/** A note, Memory, script, file, or record, with the name of the collection a record sits in. */
export type ArtifactRow = Pick<
  Artifact,
  | "id"
  | "org_id"
  | "level"
  | "owner_id"
  | "guild_id"
  | "agent_id"
  | "origin_guild_id"
  | "kind"
  | "collection_id"
  | "path"
  | "key"
  | "title"
  | "content_text"
  | "content_json"
  | "search_text"
  | "mime"
  | "bytes"
  | "version"
  | "created_by_name"
  | "updated_by_name"
  | "created_at"
  | "updated_at"
> & {
  collection_name: InferSelectModel<typeof artifactCollections>["name"] | null;
  /** The reader's mode, on a row read for a reader. */
  access?: ArtifactMode;
};

/** A row with the hash of its content, which a write compares against. */
export type HashedArtifactRow = ArtifactRow & Pick<Artifact, "content_hash">;

/** A row read with its tombstone, when it is deleted. */
export type ArtifactOrTombstoneRow = ArtifactRow & Pick<Artifact, "deleted_at">;

/** A note, file, Memory, or script by where it sits: its owner, its folder, and its file name. */
export type ArtifactAddress = Pick<Artifact, "org_id" | "level" | "owner_id" | "path" | "key">;

/** Who an artifact belongs to: its organisation, its owner, and the guild and agent it sits in. */
export type ArtifactOwner = Pick<Artifact, "org_id" | "owner_id" | "guild_id" | "agent_id">;

/** A new note as written: where it sits, who created it from which guild, and its text. */
export type NewNote = ArtifactAddress &
  ArtifactOwner &
  Pick<Artifact, "origin_guild_id" | "title" | "content_text" | "search_text" | "content_hash">;

/** A note's new text, its title, and the hash of the text. */
export type NoteContent = Pick<Artifact, "id" | "content_text" | "search_text" | "title" | "content_hash">;

/** An agent's Memory row as created: the agent, its guild, and its first text. */
export type NewMemoryRow = Pick<Artifact, "org_id" | "guild_id" | "key" | "content_text" | "content_hash"> & {
  agent_id: string;
};

/** Memory's new text, its search text, and its hash, written at the stamp the text it replaces was archived at. */
export type MemoryContent = Pick<Artifact, "id" | "content_text" | "search_text" | "content_hash"> & {
  written_at: string;
};

export type MemoryRevisionRow = InferSelectModel<typeof memoryRevisions>;

/** A Memory text being archived: whose it is, the text, and what replaced it. */
export type MemoryRevision = Pick<MemoryRevisionRow, "org_id" | "agent_id" | "content_text" | "replaced_by_detail">;

/** The name of the organisation, guild, or agent that owns the artifact `a`, or its id when it has none. */
export const OWNER_NAME_SQL = `COALESCE(CASE a.level
    WHEN 'org' THEN (SELECT o.name FROM orgs o WHERE o.id = a.owner_id)
    WHEN 'guild' THEN (SELECT g.name FROM guilds g WHERE g.id = a.owner_id)
    ELSE (SELECT ag.name FROM agents ag WHERE ag.id = a.owner_id) END, a.owner_id)`;

/** The columns of the artifact `a` that make an `ArtifactRow`, with its collection `c` joined. */
export const ARTIFACT_SELECT = `
  a.id, a.org_id, a.level, a.owner_id, a.guild_id, a.agent_id, a.origin_guild_id,
  a.kind, a.collection_id, c.name AS collection_name, a.path, a.key, a.title,
  a.content_text, a.content_json, a.search_text, a.mime, a.bytes, a.version,
  a.created_by_name, a.updated_by_name, a.created_at, a.updated_at
`;

/** The RETURNING list of an artifact write that makes an `ArtifactRow`. */
export const ARTIFACT_RETURNING = `
  id, org_id, level, owner_id, guild_id, agent_id, origin_guild_id, kind, collection_id,
  (SELECT name FROM artifact_collections WHERE id = collection_id) AS collection_name,
  path, key, title, content_text, content_json,
  search_text, mime, bytes, version, created_by_name, updated_by_name, created_at, updated_at
`;

/** The predicate over the artifact `a` leaving out the items of guilds and agents hidden from the reader. */
export function hiddenScope(reader: ArtifactReader, values: unknown[]): string {
  values.push(reader.hidden.guildIds, reader.hidden.agentIds);
  return `NOT ((a.level = 'guild' AND a.owner_id = ANY($${values.length - 1}::text[]))
            OR (a.level = 'agent' AND a.owner_id = ANY($${values.length}::text[])))`;
}

/**
 * The SQL for the reader's mode on the artifact `a`: `write` for the operator and for an agent's
 * own items, a note's or a file's access list otherwise; `none` or NULL when it does not reach it.
 */
export function artifactModeSql(reader: ArtifactReader, values: unknown[]): string {
  if (reader.operator) {
    return `'write'`;
  }
  values.push(reader.agentId ?? "");
  const own = values.length;
  return `CASE WHEN a.level = 'agent' AND a.owner_id = $${own} THEN 'write'
               WHEN a.kind = 'note' THEN ${agentModeSql("note", "a.id", reader, values)}
               WHEN a.kind = 'file' THEN ${agentModeSql("file", "a.id", reader, values)} END`;
}

/** The predicate over the artifact `a` for every note, file, Memory, and script the reader may read. */
export function readScope(reader: ArtifactReader, values: unknown[]): string {
  if (reader.operator) {
    return hiddenScope(reader, values);
  }
  return `(${artifactModeSql(reader, values)}) IN ('read', 'write')`;
}

/** A join giving each artifact `a` the reader's mode once, as `m.access`. */
function modeJoin(reader: ArtifactReader, values: unknown[]): string {
  return `CROSS JOIN LATERAL (SELECT ${artifactModeSql(reader, values)} AS access) m`;
}

/** `readScope` over an artifact `a` whose mode `modeJoin` already gives. */
function joinedReadScope(reader: ArtifactReader, values: unknown[]): string {
  return reader.operator ? hiddenScope(reader, values) : `m.access IN ('read', 'write')`;
}

function levelFilter(level: Artifact["level"] | undefined, values: unknown[]): string {
  if (!level) {
    return "";
  }
  values.push(level);
  return ` AND a.level = $${values.length}`;
}

/** An agent's live Memory row with the hash of its text, or null when it has none. */
export async function getMemoryRow(
  db: Queryable,
  orgId: string,
  agentId: string,
): Promise<HashedArtifactRow | null> {
  const result = await db.query<HashedArtifactRow>(
    `SELECT ${ARTIFACT_SELECT}, a.content_hash
       FROM artifacts a
       LEFT JOIN artifact_collections c ON c.id = a.collection_id
      WHERE a.org_id = $1 AND a.agent_id = $2 AND a.kind = 'memory' AND a.deleted_at IS NULL
      LIMIT 1`,
    [orgId, agentId],
  );
  return result.rows[0] ?? null;
}

/** Creates an agent's Memory row; null when it already has one. */
export async function insertMemoryRow(
  db: Queryable,
  memory: NewMemoryRow,
  actor: ChangeActor,
  now: Date,
): Promise<ArtifactRow | null> {
  const result = await db.query<ArtifactRow>(
    `INSERT INTO artifacts (
       id, org_id, level, owner_id, guild_id, agent_id, origin_guild_id, kind,
       collection_id, path, key, content_text, search_text, content_hash, version,
       created_by_type, created_by_id, created_by_name,
       updated_by_type, updated_by_id, updated_by_name, created_at, updated_at
     ) VALUES (
       $1,$2,'agent',$3,$4,$3,$4,'memory',NULL,'',$5,$6,$5,$7,1,
       $8,$9,$10,$8,$9,$10,$11,$11
     )
     ON CONFLICT DO NOTHING
     RETURNING ${ARTIFACT_RETURNING}`,
    [
      newId("art"),
      memory.org_id,
      memory.agent_id,
      memory.guild_id,
      memory.key,
      memory.content_text,
      memory.content_hash,
      actor.actorType,
      actor.actorId,
      actor.actorName,
      stamp(now),
    ],
  );
  return result.rows[0] ?? null;
}

/**
 * Archives the text Memory holds as a revision, replaced by `actor`; returns the
 * stamp it is archived at, a millisecond after the agent's newest revision when that is later
 * than `now`.
 */
export async function insertMemoryRevision(
  db: Queryable,
  revision: MemoryRevision,
  actor: ChangeActor,
  now: Date,
): Promise<string> {
  const writtenAt = stamp(now);
  const inserted = await db.query<{ replaced_at: string }>(
    `INSERT INTO memory_revisions (
       id, org_id, agent_id, content_text, replaced_at,
       replaced_by_type, replaced_by_id, replaced_by_name, replaced_by_detail, created_at
     )
     SELECT $1, $2, $3, $4, s.t, $6, $7, $8, $9, s.t
       FROM (
         SELECT GREATEST(
                  $5::timestamptz,
                  COALESCE(
                    (SELECT MAX(replaced_at) + interval '1 millisecond'
                       FROM memory_revisions
                      WHERE org_id = $2 AND agent_id = $3),
                    $5::timestamptz
                  )
                ) AS t
       ) s
     RETURNING replaced_at`,
    [
      newId("mrev"),
      revision.org_id,
      revision.agent_id,
      revision.content_text,
      writtenAt,
      actor.actorType,
      actor.actorId,
      actor.actorName,
      revision.replaced_by_detail,
    ],
  );
  return inserted.rows[0]?.replaced_at ?? writtenAt;
}

/** Drops an agent's Memory revisions past the newest `keep`. */
export async function pruneMemoryRevisions(
  db: Queryable,
  orgId: string,
  agentId: string,
  keep: number,
): Promise<void> {
  await db.query(
    `DELETE FROM memory_revisions
      WHERE id IN (
        SELECT id FROM memory_revisions
         WHERE org_id = $1 AND agent_id = $2
         ORDER BY replaced_at DESC
        OFFSET $3
      )`,
    [orgId, agentId, keep],
  );
}

export async function updateMemoryContent(
  db: Queryable,
  memory: MemoryContent,
  actor: ChangeActor,
): Promise<ArtifactRow> {
  const result = await db.query<ArtifactRow>(
    `UPDATE artifacts
        SET content_text = $2, search_text = $3, content_hash = $4, version = version + 1,
            updated_by_type = $5, updated_by_id = $6, updated_by_name = $7, updated_at = $8
      WHERE id = $1
      RETURNING ${ARTIFACT_RETURNING}`,
    [
      memory.id,
      memory.content_text,
      memory.search_text,
      memory.content_hash,
      actor.actorType,
      actor.actorId,
      actor.actorName,
      memory.written_at,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new RowMissing("memory row vanished during its write");
  }
  return row;
}

/** The text of an agent's Memory revision whose archive file name is `stampName`, or null. */
export async function getMemoryRevisionText(
  db: Queryable,
  orgId: string,
  agentId: string,
  stampName: string,
): Promise<string | null> {
  const result = await db.query<{ content_text: string }>(
    `SELECT content_text, replaced_at, replaced_by_name
       FROM memory_revisions
      WHERE org_id = $1 AND agent_id = $2
        AND concat(to_char(replaced_at AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS'), '-',
                   regexp_replace(replaced_by_name, '[/:]', '-', 'g'), '.md') = $3
      LIMIT 1`,
    [orgId, agentId, stampName],
  );
  return result.rows[0]?.content_text || null;
}

/** An agent's Memory revisions, newest first. */
export async function listMemoryRevisions(
  db: Queryable,
  orgId: string,
  agentId: string,
): Promise<MemoryRevisionRow[]> {
  const result = await db.query<MemoryRevisionRow>(
    `SELECT id, org_id, agent_id, content_text, replaced_at, replaced_by_type, replaced_by_id,
            replaced_by_name, replaced_by_detail, created_at
       FROM memory_revisions
      WHERE org_id = $1 AND agent_id = $2
      ORDER BY replaced_at DESC, id DESC`,
    [orgId, agentId],
  );
  return result.rows;
}

/** The live note at an address, with the hash of its text; null when there is none. */
export async function getLiveNote(db: Queryable, at: ArtifactAddress): Promise<HashedArtifactRow | null> {
  const result = await db.query<HashedArtifactRow>(
    `SELECT ${ARTIFACT_SELECT}, a.content_hash
       FROM artifacts a
       LEFT JOIN artifact_collections c ON c.id = a.collection_id
      WHERE a.org_id = $1 AND a.level = $2 AND a.owner_id = $3
        AND a.kind = 'note' AND a.collection_id IS NULL
        AND a.path = $4 AND a.key = $5 AND a.deleted_at IS NULL
      LIMIT 1`,
    [at.org_id, at.level, at.owner_id, at.path, at.key],
  );
  return result.rows[0] ?? null;
}

export async function updateNoteContent(
  db: Queryable,
  note: NoteContent,
  actor: ChangeActor,
  now: Date,
): Promise<ArtifactRow> {
  const result = await db.query<ArtifactRow>(
    `UPDATE artifacts
        SET content_text = $2, search_text = $3, title = $4,
            content_hash = $5, version = version + 1,
            updated_by_type = $6, updated_by_id = $7, updated_by_name = $8, updated_at = $9
      WHERE id = $1
      RETURNING ${ARTIFACT_RETURNING}`,
    [
      note.id,
      note.content_text,
      note.search_text,
      note.title,
      note.content_hash,
      actor.actorType,
      actor.actorId,
      actor.actorName,
      stamp(now),
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new RowMissing("note row vanished during its write");
  }
  return row;
}

export async function insertNote(
  db: Queryable,
  note: NewNote,
  actor: ChangeActor,
  now: Date,
): Promise<ArtifactRow> {
  const result = await db.query<ArtifactRow>(
    `INSERT INTO artifacts (
       id, org_id, level, owner_id, guild_id, agent_id, origin_guild_id, kind,
       collection_id, path, key, title, content_text, content_json, search_text,
       content_hash, version,
       created_by_type, created_by_id, created_by_name,
       updated_by_type, updated_by_id, updated_by_name, created_at, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,'note',NULL,$8,$9,$10,$11,NULL,$12,$13,1,
       $14,$15,$16,$14,$15,$16,$17,$17
     )
     RETURNING ${ARTIFACT_RETURNING}`,
    [
      newId("art"),
      note.org_id,
      note.level,
      note.owner_id,
      note.guild_id,
      note.agent_id,
      note.origin_guild_id,
      note.path,
      note.key,
      note.title,
      note.content_text,
      note.search_text,
      note.content_hash,
      actor.actorType,
      actor.actorId,
      actor.actorName,
      stamp(now),
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new RowMissing("note insert returned no row");
  }
  return row;
}

/** The live note, file, Memory, or script at an address; null when there is none. */
export async function getArtifactAt(db: Queryable, at: ArtifactAddress): Promise<ArtifactRow | null> {
  const result = await db.query<ArtifactRow>(
    `SELECT ${ARTIFACT_SELECT}
       FROM artifacts a
       LEFT JOIN artifact_collections c ON c.id = a.collection_id
      WHERE a.org_id = $1 AND a.level = $2 AND a.owner_id = $3
        AND a.path = $4 AND a.key = $5 AND a.collection_id IS NULL
        AND a.deleted_at IS NULL
      LIMIT 1`,
    [at.org_id, at.level, at.owner_id, at.path, at.key],
  );
  return result.rows[0] ?? null;
}

/** The note, file, Memory, or script at an address, live or deleted; null when there never was one. */
export async function getArtifactOrTombstoneAt(
  db: Queryable,
  at: ArtifactAddress,
): Promise<ArtifactOrTombstoneRow | null> {
  const result = await db.query<ArtifactOrTombstoneRow>(
    `SELECT ${ARTIFACT_SELECT}, a.deleted_at
       FROM artifacts a
       LEFT JOIN artifact_collections c ON c.id = a.collection_id
      WHERE a.org_id = $1 AND a.level = $2 AND a.owner_id = $3
        AND a.path = $4 AND a.key = $5 AND a.collection_id IS NULL
      LIMIT 1`,
    [at.org_id, at.level, at.owner_id, at.path, at.key],
  );
  return result.rows[0] ?? null;
}

/** One live artifact of the organisation by id and kind; null when there is none. */
export async function getLiveArtifact(
  db: Queryable,
  orgId: string,
  target: Pick<Artifact, "id" | "kind">,
): Promise<ArtifactRow | null> {
  const result = await db.query<ArtifactRow>(
    `SELECT ${ARTIFACT_SELECT}
       FROM artifacts a
       LEFT JOIN artifact_collections c ON c.id = a.collection_id
      WHERE a.id = $1 AND a.org_id = $2 AND a.kind = $3 AND a.deleted_at IS NULL`,
    [target.id, orgId, target.kind],
  );
  return result.rows[0] ?? null;
}

/** Soft-deletes one live artifact; returns the version it is deleted at, or null when it is not live. */
export async function softDeleteArtifact(
  db: Queryable,
  artifactId: string,
  actor: ChangeActor,
  now: Date,
): Promise<number | null> {
  const result = await db.query<{ version: number }>(
    `UPDATE artifacts
        SET deleted_at = $2, updated_by_type = $3, updated_by_id = $4,
            updated_by_name = $5, updated_at = $2
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING version`,
    [artifactId, stamp(now), actor.actorType, actor.actorId, actor.actorName],
  );
  return result.rows[0]?.version ?? null;
}

/** How many live notes, Memory, scripts, and files an owner holds. */
export async function countLiveArtifacts(
  db: Queryable,
  owner: Pick<Artifact, "org_id" | "level" | "owner_id">,
): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM artifacts
      WHERE org_id = $1 AND level = $2 AND owner_id = $3 AND deleted_at IS NULL AND kind <> 'object'`,
    [owner.org_id, owner.level, owner.owner_id],
  );
  return result.rows[0]?.n ?? 0;
}

/** Up to five agents of the organisation whose task embeds the note at `displayPath`. */
export async function listAgentsEmbedding(db: Queryable, orgId: string, displayPath: string): Promise<string[]> {
  const result = await db.query<{ agent_id: string }>(
    `SELECT id AS agent_id
       FROM agents
      WHERE org_id = $1 AND task LIKE $2
      LIMIT 5`,
    [orgId, `%![[${displayPath}]]%`],
  );
  return result.rows.map((row) => row.agent_id);
}

/** One owner's notes or files: the owner's level and id, and the kind. */
export type OwnerArtifactsKey = Pick<Artifact, "level" | "owner_id"> & { kind: "note" | "file" };

/** The live notes or files one owner holds that the reader may read, by key. */
export async function listOwnerArtifacts(
  db: Queryable,
  reader: ArtifactReader,
  owner: OwnerArtifactsKey,
): Promise<ArtifactRow[]> {
  const values: unknown[] = [reader.orgId, owner.level, owner.owner_id, owner.kind];
  const result = await db.query<ArtifactRow>(
    `SELECT ${ARTIFACT_SELECT}
       FROM artifacts a
       LEFT JOIN artifact_collections c ON c.id = a.collection_id
      WHERE a.org_id = $1 AND a.level = $2 AND a.owner_id = $3 AND a.deleted_at IS NULL
        AND a.kind = $4 AND (${readScope(reader, values)})
      ORDER BY a.key`,
    values,
  );
  return result.rows;
}

/** A guild and its agents, the owners of a guild's artifacts below the organisation. */
export type GuildArtifactOwners = { guildId: string; agentIds: string[] };

/** The live notes, Memory, scripts, and files of one guild, its agents, and the organisation that the reader may read. */
export async function listGuildArtifacts(
  db: Queryable,
  reader: ArtifactReader,
  owners: GuildArtifactOwners,
): Promise<ArtifactRow[]> {
  const values: unknown[] = [reader.orgId, owners.guildId, owners.agentIds];
  const result = await db.query<ArtifactRow>(
    `SELECT ${ARTIFACT_SELECT}
       FROM artifacts a
       LEFT JOIN artifact_collections c ON c.id = a.collection_id
      WHERE a.org_id = $1 AND a.deleted_at IS NULL AND a.kind IN ('note', 'memory', 'script', 'file')
        AND (a.level = 'org'
             OR (a.level = 'guild' AND a.owner_id = $2)
             OR (a.level = 'agent' AND a.owner_id = ANY($3::text[])))
        AND (${readScope(reader, values)})
      ORDER BY a.level, a.owner_id, a.key`,
    values,
  );
  return result.rows;
}

/** Up to 500 live notes of the organisation the reader may read, by level and key. */
export async function listReadableNotes(db: Queryable, reader: ArtifactReader): Promise<ArtifactRow[]> {
  const values: unknown[] = [reader.orgId];
  const result = await db.query<ArtifactRow>(
    `SELECT ${ARTIFACT_SELECT}
       FROM artifacts a
       LEFT JOIN artifact_collections c ON c.id = a.collection_id
      WHERE a.org_id = $1 AND a.kind = 'note' AND a.deleted_at IS NULL
        AND (${readScope(reader, values)})
      ORDER BY a.level, a.key
      LIMIT 500`,
    values,
  );
  return result.rows;
}

/** What a search or listing of notes or files reads: an optional level and a row cap. */
export type ArtifactListing = { level: Artifact["level"] | undefined; limit: number };

/** A search of notes or files: a listing and the words it matches. */
export type ArtifactSearch = ArtifactListing & { query: string };

/** The notes or files the reader may read whose search document or search text matches `query`, best first. */
export async function searchArtifactsByKind(
  db: Queryable,
  reader: ArtifactReader,
  kind: "note" | "file",
  search: ArtifactSearch,
): Promise<ArtifactRow[]> {
  const values: unknown[] = [reader.orgId, kind];
  let sql = `SELECT ${ARTIFACT_SELECT}, m.access
       FROM artifacts a
       LEFT JOIN artifact_collections c ON c.id = a.collection_id
       ${modeJoin(reader, values)}
      WHERE a.deleted_at IS NULL AND a.kind = $2 AND a.org_id = $1
        AND (${joinedReadScope(reader, values)})`;
  sql += levelFilter(search.level, values);
  values.push(search.query);
  const qIndex = values.length;
  values.push(search.limit);
  sql += ` AND (
      a.search_document @@ websearch_to_tsquery('simple', $${qIndex})
      OR a.search_text ILIKE '%' || $${qIndex} || '%'
    )
    ORDER BY ts_rank_cd(a.search_document, websearch_to_tsquery('simple', $${qIndex})) DESC, a.updated_at DESC
    LIMIT $${values.length}`;
  const result = await db.query<ArtifactRow>(sql, values);
  return result.rows;
}

/** The notes or files the reader may read, by level then key. */
export async function listArtifactsByKind(
  db: Queryable,
  reader: ArtifactReader,
  kind: "note" | "file",
  listing: ArtifactListing,
): Promise<ArtifactRow[]> {
  const values: unknown[] = [reader.orgId, kind];
  let sql = `SELECT ${ARTIFACT_SELECT}, m.access
       FROM artifacts a
       LEFT JOIN artifact_collections c ON c.id = a.collection_id
       ${modeJoin(reader, values)}
      WHERE a.deleted_at IS NULL AND a.kind = $2 AND a.org_id = $1
        AND (${joinedReadScope(reader, values)})`;
  sql += levelFilter(listing.level, values);
  values.push(listing.limit);
  sql += ` ORDER BY a.level, a.key LIMIT $${values.length}`;
  const result = await db.query<ArtifactRow>(sql, values);
  return result.rows;
}

/** The live notes `reacher` reads, without those of guilds `reader` cannot see, with their owner's name. */
export async function listReachedNotes(
  db: Queryable,
  reader: ArtifactReader,
  reacher: ArtifactReader,
): Promise<Array<ArtifactRow & { access: ArtifactMode; owner_name: string }>> {
  const values: unknown[] = [reader.orgId];
  const mode = artifactModeSql(reacher, values);
  const hidden = readScope(reader, values);
  const result = await db.query<ArtifactRow & { access: ArtifactMode; owner_name: string }>(
    `SELECT * FROM (
       SELECT ${ARTIFACT_SELECT}, ${mode} AS access, ${OWNER_NAME_SQL} AS owner_name
         FROM artifacts a
         LEFT JOIN artifact_collections c ON c.id = a.collection_id
        WHERE a.org_id = $1 AND a.kind = 'note' AND a.deleted_at IS NULL AND (${hidden})
     ) reached
      WHERE reached.access IN ('read', 'write')
      ORDER BY reached.level, reached.owner_id, reached.key`,
    values,
  );
  return result.rows;
}

/** A new file as written: where it sits, who created it from which guild, and its description, type, and size. */
export type NewFile = ArtifactAddress &
  ArtifactOwner &
  Pick<Artifact, "id" | "origin_guild_id" | "title" | "search_text" | "mime" | "bytes" | "content_hash">;

/** A file's new description, type, size, and hash, over the version it replaces. */
export type FileContent = Pick<Artifact, "id" | "title" | "search_text" | "mime" | "bytes" | "content_hash" | "version">;

export async function insertFile(db: Queryable, file: NewFile, actor: ChangeActor, now: Date): Promise<ArtifactRow> {
  const result = await db.query<ArtifactRow>(
    `INSERT INTO artifacts (
       id, org_id, level, owner_id, guild_id, agent_id, origin_guild_id, kind,
       collection_id, path, key, title, content_text, content_json, search_text, mime, bytes,
       content_hash, version,
       created_by_type, created_by_id, created_by_name,
       updated_by_type, updated_by_id, updated_by_name, created_at, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,'file',NULL,$8,$9,$10,NULL,NULL,$11,$12,$13,$14,1,
       $15,$16,$17,$15,$16,$17,$18,$18
     )
     RETURNING ${ARTIFACT_RETURNING}`,
    [
      file.id,
      file.org_id,
      file.level,
      file.owner_id,
      file.guild_id,
      file.agent_id,
      file.origin_guild_id,
      file.path,
      file.key,
      file.title,
      file.search_text,
      file.mime,
      file.bytes,
      file.content_hash,
      actor.actorType,
      actor.actorId,
      actor.actorName,
      stamp(now),
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new RowMissing("file insert returned no row");
  }
  return row;
}

/** Replaces a live file's content one version up; null when it is gone or its version moved on. */
export async function updateFileContent(
  db: Queryable,
  file: FileContent,
  actor: ChangeActor,
  now: Date,
): Promise<ArtifactRow | null> {
  const result = await db.query<ArtifactRow>(
    `UPDATE artifacts
        SET title = $2, search_text = $3, mime = $4, bytes = $5, content_hash = $6, version = version + 1,
            updated_by_type = $7, updated_by_id = $8, updated_by_name = $9, updated_at = $10
      WHERE id = $1 AND deleted_at IS NULL AND version = $11
      RETURNING ${ARTIFACT_RETURNING}`,
    [
      file.id,
      file.title,
      file.search_text,
      file.mime,
      file.bytes,
      file.content_hash,
      actor.actorType,
      actor.actorId,
      actor.actorName,
      stamp(now),
      file.version,
    ],
  );
  return result.rows[0] ?? null;
}

/** The bytes the organisation's live files hold, leaving out the file `exceptId` names. */
export async function sumOrgFileBytes(db: Queryable, orgId: string, exceptId: string | null): Promise<number> {
  const result = await db.query<{ n: string | number }>(
    `SELECT COALESCE(SUM(bytes), 0)::bigint AS n FROM artifacts
      WHERE org_id = $1 AND kind = 'file' AND deleted_at IS NULL AND id IS DISTINCT FROM $2`,
    [orgId, exceptId],
  );
  return Number(result.rows[0]?.n ?? 0);
}
