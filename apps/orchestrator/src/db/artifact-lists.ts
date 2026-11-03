import type { InferSelectModel } from "drizzle-orm";
import { agentModeSql, type ArtifactMode, type ArtifactReader } from "./artifact-access.js";
import { ARTIFACT_SELECT, artifactModeSql, guildScopeSql, hiddenScope, readScope, type ArtifactRow } from "./artifacts.js";
import type { Queryable } from "./pg.js";
import type { artifacts, guilds } from "./schema/index.js";

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

/**
 * The mode an organisation's or a guild's list shows for an item: `all_write` or `all_read` when an
 * organisation row, or the guild's own row, reaches every agent, the better mode when both do, and
 * no agent row at `none` shuts one of them out; `some` when such a row shuts one out, or only rows
 * of single agents reach some of them; `none` when no row reaches any.
 */
export type GuildViewerMode = "all_write" | "all_read" | "some" | "none";

/** The mode an agent's list shows for an item: the agent's own mode on it, `none` when no row reaches it. */
export type AgentViewerMode = "write" | "read" | "none";

/**
 * A note or a file as a page lists it: its row, the name of the guild it is homed in (null when it
 * is the organisation's), and the page viewer's mode on it.
 */
export type PageArtifactRow<Mode> = ArtifactRow & {
  home_name: InferSelectModel<typeof guilds>["name"] | null;
  viewer_mode: Mode;
};

/** A row a guild's or an agent's page lists, with whether it is homed in the page's guild. */
export type SectionedArtifactRow<Mode> = PageArtifactRow<Mode> & { homed: boolean };

/** A join giving each artifact `a` the name of the guild it is homed in, as `hg.name`. */
const HOME_JOIN = `LEFT JOIN guilds hg ON hg.id = a.origin_guild_id`;

/**
 * A join giving each artifact `a` a viewer's mode on it (`GuildViewerMode`), as `v.viewer_mode`,
 * from one pass over the item's rows. Over a row `x`, the SQL predicate `allRow` picks a row that
 * reaches every agent of the viewer, `someRow` one that reaches some of them, and `ownAgentRow` the
 * row of one of them, which shuts that agent out at `none`.
 */
function viewerJoin(allRow: string, someRow: string, ownAgentRow: string): string {
  return `CROSS JOIN LATERAL (
    SELECT CASE
             WHEN max(x.mode) FILTER (WHERE ${allRow}) IS NOT NULL
                  AND NOT bool_or(x.mode = 'none' AND ${ownAgentRow})
               THEN CASE max(x.mode) FILTER (WHERE ${allRow}) WHEN 'write' THEN 'all_write' ELSE 'all_read' END
             WHEN bool_or(x.mode <> 'none' AND ${someRow}) THEN 'some'
             ELSE 'none'
           END AS viewer_mode
      FROM artifact_access x
     WHERE x.target_kind = a.kind AND x.target_id = a.id) v`;
}

/** A join giving each artifact `a` the organisation's viewer mode on it (`GuildViewerMode`), as `v.viewer_mode`. */
const ORG_VIEWER_JOIN = viewerJoin(`x.subject_type = 'org'`, `true`, `x.subject_type = 'agent'`);

/**
 * A join giving each artifact `a` the viewer mode (`GuildViewerMode`) of the guild whose id is the
 * SQL `guildId`, as `v.viewer_mode`.
 */
function guildViewerJoin(guildId: string): string {
  const allRow = `(x.subject_type = 'org' OR (x.subject_type = 'guild' AND x.subject_id = ${guildId}))`;
  const ownAgentRow = `(x.subject_type = 'agent' AND x.subject_id IN (SELECT ag.id FROM agents ag WHERE ag.guild_id = ${guildId}))`;
  return viewerJoin(allRow, `(${allRow} OR ${ownAgentRow})`, ownAgentRow);
}

/**
 * The predicate over the artifact `a` for an item a guild's page lists: homed in the guild whose id
 * is the SQL `guildId`, or in its scope (`guildScopeSql`).
 */
function onGuildPage(guildId: string): string {
  return `(COALESCE(a.origin_guild_id = ${guildId}, false) OR ${guildScopeSql(guildId)})`;
}

/** The organisation's live notes or files the reader may read, by key, with the organisation's viewer mode. */
export async function listOrgArtifacts(
  db: Queryable,
  reader: ArtifactReader,
  kind: ListedKind,
): Promise<Array<PageArtifactRow<GuildViewerMode>>> {
  const values: unknown[] = [reader.orgId, kind];
  const result = await db.query<PageArtifactRow<GuildViewerMode>>(
    `SELECT ${ARTIFACT_SELECT}, hg.name AS home_name, v.viewer_mode
       FROM artifacts a
       LEFT JOIN artifact_collections c ON c.id = a.collection_id
       ${HOME_JOIN}
       ${ORG_VIEWER_JOIN}
      WHERE a.org_id = $1 AND a.deleted_at IS NULL AND a.kind = $2
        AND (${readScope(reader, values)})
      ORDER BY a.key`,
    values,
  );
  return result.rows;
}

/**
 * The live notes or files a guild's page lists for the operator `reader`, by key: those homed in the
 * guild, whatever their rows, and those in its scope, each with the guild's viewer mode. Nothing
 * hidden from the reader.
 */
export async function listGuildPageArtifacts(
  db: Queryable,
  reader: ArtifactReader,
  guildId: string,
  kind: ListedKind,
): Promise<Array<SectionedArtifactRow<GuildViewerMode>>> {
  const values: unknown[] = [reader.orgId, kind, guildId];
  const result = await db.query<SectionedArtifactRow<GuildViewerMode>>(
    `SELECT ${ARTIFACT_SELECT}, hg.name AS home_name, v.viewer_mode,
            COALESCE(a.origin_guild_id = $3, false) AS homed
       FROM artifacts a
       LEFT JOIN artifact_collections c ON c.id = a.collection_id
       ${HOME_JOIN}
       ${guildViewerJoin("$3")}
      WHERE a.org_id = $1 AND a.deleted_at IS NULL AND a.kind = $2 AND ${onGuildPage("$3")}
        AND (${hiddenScope(reader, values)})
      ORDER BY a.key`,
    values,
  );
  return result.rows;
}

/**
 * The live notes or files an agent's page lists for the operator `reader`, by key: what the page of
 * the agent's guild lists, each with the agent's viewer mode, `reacher` reading as the agent.
 * Nothing hidden from the reader.
 */
export async function listAgentPageArtifacts(
  db: Queryable,
  reader: ArtifactReader,
  reacher: ArtifactReader,
  kind: ListedKind,
): Promise<Array<SectionedArtifactRow<AgentViewerMode>>> {
  const values: unknown[] = [reader.orgId, kind, reacher.guildId ?? ""];
  const mode = agentModeSql(kind, "a.id", reacher, values);
  const result = await db.query<SectionedArtifactRow<AgentViewerMode>>(
    `SELECT ${ARTIFACT_SELECT}, hg.name AS home_name, v.viewer_mode,
            COALESCE(a.origin_guild_id = $3, false) AS homed
       FROM artifacts a
       LEFT JOIN artifact_collections c ON c.id = a.collection_id
       ${HOME_JOIN}
       CROSS JOIN LATERAL (SELECT COALESCE(${mode}, 'none') AS viewer_mode) v
      WHERE a.org_id = $1 AND a.deleted_at IS NULL AND a.kind = $2 AND ${onGuildPage("$3")}
        AND (${hiddenScope(reader, values)})
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
