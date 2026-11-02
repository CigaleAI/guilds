import type { InferSelectModel } from "drizzle-orm";
import { type ArtifactMode, type ArtifactReader } from "./artifact-access.js";
import { ARTIFACT_SELECT, artifactModeSql, guildScopeSql, hiddenScope, readScope, type ArtifactRow } from "./artifacts.js";
import type { Queryable } from "./pg.js";
import type { artifacts } from "./schema/index.js";

type Artifact = InferSelectModel<typeof artifacts>;

/** A join giving each artifact `a` the reader's mode once, as `m.access`. */
function modeJoin(reader: ArtifactReader, values: unknown[]): string {
  return `CROSS JOIN LATERAL (SELECT ${artifactModeSql(reader, values)} AS access) m`;
}

/** `readScope` over an artifact `a` whose mode `modeJoin` already gives. */
function joinedReadScope(reader: ArtifactReader, values: unknown[]): string {
  return reader.operator ? hiddenScope(reader, values) : `m.access IN ('read', 'write')`;
}

/** The two kinds an access list governs, which an organisation, a guild, or an agent page lists. */
export type ListedKind = Extract<Artifact["kind"], "note" | "file">;

/** The organisation's live notes or files the reader may read, by key. */
export async function listOrgArtifacts(db: Queryable, reader: ArtifactReader, kind: ListedKind): Promise<ArtifactRow[]> {
  const values: unknown[] = [reader.orgId, kind];
  const result = await db.query<ArtifactRow>(
    `SELECT ${ARTIFACT_SELECT}
       FROM artifacts a
       LEFT JOIN artifact_collections c ON c.id = a.collection_id
      WHERE a.org_id = $1 AND a.deleted_at IS NULL AND a.kind = $2
        AND (${readScope(reader, values)})
      ORDER BY a.key`,
    values,
  );
  return result.rows;
}

/** The live notes or files in the guild's scope (`guildScopeSql`) that the reader may read, by key. */
export async function listGuildArtifacts(
  db: Queryable,
  reader: ArtifactReader,
  guildId: string,
  kind: ListedKind,
): Promise<ArtifactRow[]> {
  const values: unknown[] = [reader.orgId, kind, guildId];
  const result = await db.query<ArtifactRow>(
    `SELECT ${ARTIFACT_SELECT}
       FROM artifacts a
       LEFT JOIN artifact_collections c ON c.id = a.collection_id
      WHERE a.org_id = $1 AND a.deleted_at IS NULL AND a.kind = $2 AND ${guildScopeSql("$3")}
        AND (${readScope(reader, values)})
      ORDER BY a.key`,
    values,
  );
  return result.rows;
}

/**
 * What one guild's state holds that the reader may read: its agents' Memory and scripts, and the
 * notes and files in its scope (`guildScopeSql`).
 */
export async function listGuildStateArtifacts(
  db: Queryable,
  reader: ArtifactReader,
  guildId: string,
): Promise<ArtifactRow[]> {
  const values: unknown[] = [reader.orgId, guildId];
  const result = await db.query<ArtifactRow>(
    `SELECT ${ARTIFACT_SELECT}
       FROM artifacts a
       LEFT JOIN artifact_collections c ON c.id = a.collection_id
      WHERE a.org_id = $1 AND a.deleted_at IS NULL
        AND ((a.kind IN ('memory', 'script') AND a.agent_id IN (SELECT ag.id FROM agents ag WHERE ag.guild_id = $2))
             OR (a.kind IN ('note', 'file') AND ${guildScopeSql("$2")}))
        AND (${readScope(reader, values)})
      ORDER BY a.kind, a.agent_id NULLS FIRST, a.key`,
    values,
  );
  return result.rows;
}

/** Up to 500 live notes of the organisation the reader may read, by key. */
export async function listReadableNotes(db: Queryable, reader: ArtifactReader): Promise<ArtifactRow[]> {
  const values: unknown[] = [reader.orgId];
  const result = await db.query<ArtifactRow>(
    `SELECT ${ARTIFACT_SELECT}
       FROM artifacts a
       LEFT JOIN artifact_collections c ON c.id = a.collection_id
      WHERE a.org_id = $1 AND a.kind = 'note' AND a.deleted_at IS NULL
        AND (${readScope(reader, values)})
      ORDER BY a.key
      LIMIT 500`,
    values,
  );
  return result.rows;
}

/** A search of notes or files: the words it matches and a row cap. */
export type ArtifactSearch = { query: string; limit: number };

/** The notes or files the reader may read whose search document or search text matches `query`, best first. */
export async function searchArtifactsByKind(
  db: Queryable,
  reader: ArtifactReader,
  kind: ListedKind,
  search: ArtifactSearch,
): Promise<ArtifactRow[]> {
  const values: unknown[] = [reader.orgId, kind];
  let sql = `SELECT ${ARTIFACT_SELECT}, m.access
       FROM artifacts a
       LEFT JOIN artifact_collections c ON c.id = a.collection_id
       ${modeJoin(reader, values)}
      WHERE a.deleted_at IS NULL AND a.kind = $2 AND a.org_id = $1
        AND (${joinedReadScope(reader, values)})`;
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

/** The notes or files the reader may read, by key, up to `limit`. */
export async function listArtifactsByKind(
  db: Queryable,
  reader: ArtifactReader,
  kind: ListedKind,
  limit: number,
): Promise<ArtifactRow[]> {
  const values: unknown[] = [reader.orgId, kind];
  let sql = `SELECT ${ARTIFACT_SELECT}, m.access
       FROM artifacts a
       LEFT JOIN artifact_collections c ON c.id = a.collection_id
       ${modeJoin(reader, values)}
      WHERE a.deleted_at IS NULL AND a.kind = $2 AND a.org_id = $1
        AND (${joinedReadScope(reader, values)})`;
  values.push(limit);
  sql += ` ORDER BY a.key LIMIT $${values.length}`;
  const result = await db.query<ArtifactRow>(sql, values);
  return result.rows;
}

/** A row read with the mode an agent reaches it with. */
export type ReachedArtifactRow = ArtifactRow & { access: ArtifactMode };

/** The live notes or files `reacher` reads, without those hidden from `reader`, by key. */
export async function listReachedArtifacts(
  db: Queryable,
  reader: ArtifactReader,
  reacher: ArtifactReader,
  kind: ListedKind,
): Promise<ReachedArtifactRow[]> {
  const values: unknown[] = [reader.orgId, kind];
  const mode = artifactModeSql(reacher, values);
  const hidden = readScope(reader, values);
  const result = await db.query<ReachedArtifactRow>(
    `SELECT * FROM (
       SELECT ${ARTIFACT_SELECT}, ${mode} AS access
         FROM artifacts a
         LEFT JOIN artifact_collections c ON c.id = a.collection_id
        WHERE a.org_id = $1 AND a.kind = $2 AND a.deleted_at IS NULL AND (${hidden})
     ) reached
      WHERE reached.access IN ('read', 'write')
      ORDER BY reached.key`,
    values,
  );
  return result.rows;
}
