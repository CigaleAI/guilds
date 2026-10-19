import { createHash } from "node:crypto";
import type pg from "pg";
import { formatColumnTimestamp, formatOperationalTimestamp } from "../db/codecs.js";
import { isUniqueViolation, stamp, withTransaction } from "../db/pg.js";
import { newId } from "../lib/ids.js";
import { EMPTY_MEMORY } from "../memory/index.js";
import {
  columnCatalog,
  columnNamed,
  columnsOf,
  identityFor,
  normalizeIdentity,
  parseColumnChange,
  parseColumns,
  recordProblems,
  recordRejected,
  uniqueColumn,
  validateAdd,
  validatePatch,
  type CollectionColumn,
} from "./columns.js";
import { ArtifactError } from "./errors.js";
import { recordFileChange } from "./file-changes.js";
import { collectionCleared, collectionColumnsChanged, collectionDeleted, type CollectionRef } from "./collection-changes.js";
import { recordChangeIfAny, recordConfigChange } from "../db/config-changes.js";
import { operatorActor } from "./grants.js";
import {
  allowsSimilarSpelling,
  FUZZY_THRESHOLD,
  isSingleToken,
  parseLimit,
  parseOffset,
  parseOrder,
  parseRecordId,
  parseSince,
  parseWhere,
  searchBlobFor,
  type OrderClause,
  type WhereClause,
} from "./search.js";
import {
  assertNoteKeyFree,
  collectionDisplayPath,
  displayPathFor,
  HISTORY_ARCHIVE_SEGMENT,
  isDisplayPath,
  MEMORY_KEY,
  normalizeNoteKey,
  parseDisplayPath,
  revisionDisplayPath,
  TASK_KEY,
  type ParsedDisplayPath,
} from "./paths.js";
import {
  COLLECTION_NAME_RE,
  FIND_DEFAULT,
  FIND_MAX,
  isAccessMode,
  isAgentAccessMode,
  isAccessSubject,
  LIVE_ARTIFACTS_MAX,
  LIVE_COLLECTIONS_MAX,
  LIVE_RECORDS_MAX,
  MEMORY_REVISIONS_MAX,
  resolveAccess,
  PURPOSE_MAX,
  SEARCH_TEXT_MAX,
  STATE_COLLECTIONS_MAX,
  WRITE_MAX_BYTES,
  type AccessMode,
  type AccessSubject,
  type AgentAccessMode,
  type ArtifactActor,
  type ArtifactKind,
  type ArtifactLevel,
} from "./types.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

const ISO_DATETIME_SQL_RE = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$`;

export type ArtifactRow = {
  id: string;
  org_id: string;
  level: ArtifactLevel;
  owner_id: string;
  guild_id: string | null;
  agent_id: string | null;
  origin_guild_id: string | null;
  kind: ArtifactKind;
  collection_id: string | null;
  collection_name: string | null;
  path: string;
  key: string;
  title: string | null;
  content_text: string | null;
  content_json: unknown;
  search_text: string | null;
  version: number;
  created_by_name: string;
  updated_by_name: string;
  created_at: string;
  updated_at: string;
};

export type MemoryRevisionRow = {
  id: string;
  content: string;
  display_path: string;
  path: string;
  replaced_at: string;
  replaced_by: { type: "user" | "agent" | "run"; id: string; name: string; detail: string };
};

export type CollectionRow = {
  id: string;
  org_id: string;
  /** The guild the table belongs to; null for an organisation table. */
  guild_id: string | null;
  guild_name: string | null;
  name: string;
  purpose: string;
  columns: CollectionColumn[];
  next_id: number;
  created_by_name: string;
  created_at: string;
  updated_at: string;
};

/** A collection as the operator or an agent sees it. */
export type CollectionView = {
  id: string;
  name: string;
  purpose: string;
  columns: CollectionColumn[];
  display_path: string;
  /** `guild` when the table belongs to one guild, `org` when it is an organisation table. */
  scope: "guild" | "org";
  guild: { id: string; name: string } | null;
  access: AccessMode;
  created_at: string;
  updated_at: string;
  count?: number;
};

export type RecordView = Record<string, unknown>;

export type CollectionDescription = {
  id: string;
  name: string;
  purpose: string;
  columns: CollectionColumn[];
  guild_id: string | null;
  access: AccessMode;
};

function collectionRef(row: CollectionRow): CollectionRef {
  return { id: row.id, name: row.name, orgId: row.org_id, guildId: row.guild_id };
}

export class ArtifactStore {
  constructor(
    public pool: pg.Pool,
    public templatesRoot = "",
  ) {}

  operatorContext(
    orgId: string,
    actorId: string,
    actorName: string,
    extra: { guildId?: string | null; agentId?: string | null } = {},
  ): ArtifactActor {
    return operatorActor({
      orgId,
      actorId,
      actorName,
      guildId: extra.guildId ?? null,
      agentId: extra.agentId ?? null,
    });
  }

  async ensureAgentRows(args: {
    orgId: string;
    guildId: string;
    agentId: string;
    actor: ArtifactActor;
  }): Promise<void> {
    await this.upsertReserved(args.actor, args.orgId, args.guildId, args.agentId, "memory", MEMORY_KEY, EMPTY_MEMORY);
  }

  async readMemory(actor: ArtifactActor, agentId: string): Promise<string> {
    const row = await this.loadReserved(actor, agentId, "memory");
    return row?.content_text || EMPTY_MEMORY;
  }

  async getMemoryRow(
    actor: ArtifactActor,
    agentId: string,
    client?: Queryable,
  ): Promise<(ArtifactRow & { content_hash: string }) | null> {
    return this.loadReserved(actor, agentId, "memory", client);
  }

  async writeMemory(
    actor: ArtifactActor,
    agentId: string,
    content: string,
    detail: string,
    expectedVersion?: number,
  ): Promise<ArtifactRow> {
    if (!actor.operator && actor.agentId !== agentId) {
      throw new ArtifactError("memory is not writable", 422);
    }
    this.assertBytes(content);
    const existing = await this.loadReserved(actor, agentId, "memory");
    if (!existing) {
      if (!actor.guildId) {
        throw new ArtifactError("memory.md not found", 404);
      }
      await this.upsertReserved(actor, actor.orgId, actor.guildId, agentId, "memory", MEMORY_KEY, EMPTY_MEMORY);
    }
    const live = existing ?? (await this.loadReserved(actor, agentId, "memory"));
    if (!live) {
      throw new ArtifactError("memory.md not found", 404);
    }
    if (expectedVersion !== undefined && live.version !== expectedVersion) {
      throw new ArtifactError("version conflict", 409);
    }
    const hash = contentHash(content, null);
    return withTransaction(this.pool, async (client) => {
      const now = new Date();
      let writtenAt = stamp(now);
      if (live.content_hash !== hash) {
        const inserted = await client.query(
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
            live.org_id,
            agentId,
            live.content_text,
            writtenAt,
            actor.actorType,
            actor.actorId,
            actor.actorName,
            detail,
          ],
        );
        const raw = inserted.rows[0]?.replaced_at as Date | string | undefined;
        if (raw instanceof Date) {
          writtenAt = stamp(raw);
        } else if (raw) {
          writtenAt = String(raw);
        }
        await client.query(
          `DELETE FROM memory_revisions
            WHERE id IN (
              SELECT id FROM memory_revisions
               WHERE org_id = $1 AND agent_id = $2
               ORDER BY replaced_at DESC
              OFFSET $3
            )`,
          [live.org_id, agentId, MEMORY_REVISIONS_MAX],
        );
      }
      const result = await client.query(
        `UPDATE artifacts
            SET content_text = $2, search_text = $3, content_hash = $4, version = version + 1,
                updated_by_type = $5, updated_by_id = $6, updated_by_name = $7, updated_at = $8
          WHERE id = $1
          RETURNING ${ARTIFACT_RETURNING}`,
        [
          live.id,
          content,
          MEMORY_KEY,
          hash,
          actor.actorType,
          actor.actorId,
          actor.actorName,
          writtenAt,
        ],
      );
      const row = mapRow(result.rows[0] as Record<string, unknown>);
      await recordFileChange(client, actor, {
        orgId: row.org_id,
        artifactId: row.id,
        displayPath: displayPathFor(rowAsDisplay(row)),
        operation: "update",
        version: row.version,
      });
      return row;
    });
  }

  /** Notes sit directly under their owner: `level` picks the owner, `key` names the file. */
  async writeNote(
    actor: ArtifactActor,
    args: {
      level: ArtifactLevel;
      key: string;
      content: string;
      title?: string;
      expectedVersion?: number;
    },
  ): Promise<ArtifactRow> {
    const key = normalizeNoteKey(args.key);
    assertNoteKeyFree(args.level, key);
    this.assertBytes(args.content);
    this.assertWriteLevel(actor, args.level);
    const owner = this.ownerFor(actor, args.level);
    await this.assertLiveCount(owner.orgId, args.level, owner.ownerId);
    const searchText = [args.title ?? "", key].filter(Boolean).join(" ").slice(0, SEARCH_TEXT_MAX);
    return this.upsertContent(actor, {
      level: args.level,
      owner,
      kind: "note",
      path: "",
      key,
      title: args.title ?? null,
      contentText: args.content,
      searchText,
      ...(args.expectedVersion !== undefined ? { expectedVersion: args.expectedVersion } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Collections: organisation-scoped typed tables managed by the operator.

  async createCollection(
    actor: ArtifactActor,
    args: { name: string; purpose: string; columns?: unknown; guildId?: string | null },
  ): Promise<CollectionView> {
    this.assertOperator(actor);
    const name = validateCollectionName(args.name);
    const purpose = validatePurpose(args.purpose);
    const columns = parseColumns(args.columns ?? []);
    const guildId = args.guildId ? await this.requireGuild(actor, args.guildId) : null;
    const count = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM artifact_collections WHERE org_id = $1 AND deleted_at IS NULL`,
      [actor.orgId],
    );
    if (Number(count.rows[0]?.n ?? 0) >= LIVE_COLLECTIONS_MAX) {
      throw new ArtifactError("collection limit reached", 422);
    }
    const now = stamp(new Date());
    try {
      const result = await this.pool.query(
        `INSERT INTO artifact_collections (
           id, org_id, guild_id, name, purpose, columns, next_id,
           created_by_type, created_by_id, created_by_name, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6::json,1,$7,$8,$9,$10,$10)
         RETURNING ${COLLECTION_SELECT}`,
        [newId("acol"), actor.orgId, guildId, name, purpose, JSON.stringify(columns), actor.actorType, actor.actorId, actor.actorName, now],
      );
      return this.collectionView(mapCollection(result.rows[0] as Record<string, unknown>), "write", 0);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ArtifactError("collection already exists", 409);
      }
      throw error;
    }
  }

  /**
   * Replaces a collection's name, purpose, scope, or columns. A column
   * change is applied to the live records in the same transaction: a
   * renamed column moves its key, a removed column drops it, and a column
   * that becomes unique is refused while live records repeat a value.
   * Moving a table to a guild drops every grant, since the guild's members
   * always write their own table; moving it to the organisation keeps the
   * former guild's reach as a `write` grant.
   */
  async updateCollection(
    actor: ArtifactActor,
    collectionId: string,
    args: { name?: string; purpose?: string; columns?: unknown; guildId?: string | null },
  ): Promise<CollectionView> {
    this.assertOperator(actor);
    const current = await this.loadCollectionById(actor, collectionId);
    if (!current) {
      throw new ArtifactError("unknown collection", 404);
    }
    const name = args.name === undefined ? current.name : validateCollectionName(args.name);
    const purpose = args.purpose === undefined ? current.purpose : validatePurpose(args.purpose);
    const change = args.columns === undefined ? null : parseColumnChange(current.columns, args.columns);
    const columns = change ? change.columns : current.columns;
    const guildId =
      args.guildId === undefined ? current.guild_id : args.guildId ? await this.requireGuild(actor, args.guildId) : null;
    const now = stamp(new Date());
    await withTransaction(this.pool, async (client) => {
      await client.query(`SELECT id FROM artifact_collections WHERE id = $1 FOR UPDATE`, [current.id]);
      if (guildId !== current.guild_id) {
        await client.query(`DELETE FROM collection_access WHERE collection_id = $1`, [current.id]);
        if (guildId === null && current.guild_id) {
          await client.query(
            `INSERT INTO collection_access (
               id, org_id, collection_id, subject_type, subject_id, mode,
               created_by_type, created_by_id, created_by_name, created_at
             ) VALUES ($1,$2,$3,'guild',$4,'write',$5,$6,$7,$8)`,
            [newId("cacc"), actor.orgId, current.id, current.guild_id, actor.actorType, actor.actorId, actor.actorName, now],
          );
        }
      }
      if (change) {
        await recordChangeIfAny(client, actor, collectionColumnsChanged(collectionRef(current), change));
        for (const rename of change.renamed) {
          await client.query(
            `UPDATE artifacts
                SET content_json = (content_json - $2::text) || jsonb_build_object($3::text, content_json -> $2::text)
              WHERE collection_id = $1 AND kind = 'object' AND deleted_at IS NULL AND content_json ? $2::text`,
            [current.id, rename.from, rename.to],
          );
        }
        for (const removed of change.removed) {
          await client.query(
            `UPDATE artifacts SET content_json = content_json - $2::text
              WHERE collection_id = $1 AND kind = 'object' AND deleted_at IS NULL AND content_json ? $2::text`,
            [current.id, removed],
          );
        }
        const unique = uniqueColumn(columns);
        const previousUnique = uniqueColumn(current.columns);
        if (!unique) {
          await client.query(
            `UPDATE artifacts SET identity = NULL WHERE collection_id = $1 AND kind = 'object' AND identity IS NOT NULL`,
            [current.id],
          );
        } else if (
          !previousUnique ||
          previousUnique.name !== unique.name ||
          previousUnique.type !== unique.type ||
          change.renamed.some((item) => item.to === unique.name)
        ) {
          await this.reindexIdentity(client, current.id, unique);
        }
        if (change.renamed.length || change.removed.length) {
          await client.query(
            `UPDATE artifacts a
                SET search_blob = left(a.key || COALESCE((
                        SELECT ' ' || string_agg(t.v, ' ' ORDER BY t.k)
                          FROM jsonb_each_text(a.content_json) AS t(k, v)
                         WHERE t.v IS NOT NULL AND btrim(t.v) <> ''), ''), 32768)
              WHERE a.collection_id = $1 AND a.kind = 'object' AND a.deleted_at IS NULL`,
            [current.id],
          );
        }
      }
      try {
        await client.query(
          `UPDATE artifact_collections SET name = $2, purpose = $3, columns = $4::json, guild_id = $5, updated_at = $6
            WHERE id = $1 AND deleted_at IS NULL`,
          [current.id, name, purpose, JSON.stringify(columns), guildId, now],
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ArtifactError("collection already exists", 409);
        }
        throw error;
      }
    });
    const updated = await this.loadCollectionById(actor, current.id);
    if (!updated) {
      throw new ArtifactError("unknown collection", 404);
    }
    return this.collectionView(updated, "write", await this.countRecords(updated.id));
  }

  /** Soft-deletes a collection with every record in it and drops its grants. */
  async deleteCollection(actor: ArtifactActor, collectionId: string): Promise<void> {
    this.assertOperator(actor);
    const collection = await this.loadCollectionById(actor, collectionId);
    if (!collection) {
      throw new ArtifactError("unknown collection", 404);
    }
    const now = stamp(new Date());
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `UPDATE artifacts SET deleted_at = $2, updated_by_type = $3, updated_by_id = $4, updated_by_name = $5, updated_at = $2
          WHERE collection_id = $1 AND deleted_at IS NULL`,
        [collection.id, now, actor.actorType, actor.actorId, actor.actorName],
      );
      await client.query(
        `UPDATE artifact_collections SET deleted_at = $2, updated_at = $2 WHERE id = $1 AND deleted_at IS NULL`,
        [collection.id, now],
      );
      await client.query(`DELETE FROM collection_access WHERE collection_id = $1`, [collection.id]);
      await recordConfigChange(client, actor, collectionDeleted(collectionRef(collection)));
    });
  }

  /**
   * Soft-deletes every live record. The collection, its grants, and `next_id`
   * stay, so later inserts keep numbering from where the table left off.
   */
  async clearRecords(actor: ArtifactActor, collectionId: string): Promise<number> {
    this.assertOperator(actor);
    const collection = await this.loadCollectionById(actor, collectionId);
    if (!collection) {
      throw new ArtifactError("unknown collection", 404);
    }
    const now = stamp(new Date());
    return withTransaction(this.pool, async (client) => {
      const locked = await client.query(
        `SELECT id FROM artifact_collections WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [collection.id],
      );
      if (!locked.rows[0]) {
        throw new ArtifactError("unknown collection", 404);
      }
      const result = await client.query(
        `UPDATE artifacts
            SET deleted_at = $2, updated_by_type = $3, updated_by_id = $4, updated_by_name = $5, updated_at = $2
          WHERE collection_id = $1 AND kind = 'object' AND deleted_at IS NULL`,
        [collection.id, now, actor.actorType, actor.actorId, actor.actorName],
      );
      const removed = result.rowCount ?? 0;
      await recordChangeIfAny(client, actor, collectionCleared(collectionRef(collection), removed));
      return removed;
    });
  }

  /**
   * The live collections the actor can read, with the actor's access mode.
   * The operator sees every collection in the organisation.
   */
  async listCollections(actor: ArtifactActor, options: { counts?: boolean } = {}): Promise<CollectionView[]> {
    const rows = await this.accessibleCollections(actor);
    const counts = options.counts ? await this.countByCollection(rows.map((item) => item.row.id)) : null;
    return rows.map((item) =>
      this.collectionView(item.row, item.mode, counts ? (counts.get(item.row.id) ?? 0) : undefined),
    );
  }

  /** The State catalog: name, purpose, access, display path, and columns; capped. */
  async catalog(actor: ArtifactActor, limit = STATE_COLLECTIONS_MAX): Promise<Array<Record<string, unknown>>> {
    const rows = await this.accessibleCollections(actor);
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

  async getCollection(actor: ArtifactActor, collectionId: string): Promise<CollectionView> {
    const collection = await this.loadCollectionById(actor, collectionId);
    if (!collection) {
      throw new ArtifactError("unknown collection", 404);
    }
    const mode = await this.accessMode(actor, collection);
    if (!mode) {
      throw new ArtifactError("unknown collection", 404);
    }
    return this.collectionView(collection, mode, await this.countRecords(collection.id));
  }

  /** The collection by name with the actor's access, or null when unknown or unreadable. */
  async describeCollection(actor: ArtifactActor, name: string): Promise<CollectionDescription | null> {
    let collectionName: string;
    try {
      collectionName = validateCollectionName(name);
    } catch {
      return null;
    }
    const collection = await this.loadCollectionByName(actor, collectionName);
    if (!collection) {
      return null;
    }
    const mode = await this.accessMode(actor, collection);
    if (!mode) {
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

  /**
   * What an empty search should say about a collection the actor can read:
   * how many records it holds, when the newest changed, and its columns.
   */
  async collectionFacts(
    actor: ArtifactActor,
    name: string,
  ): Promise<{ name: string; count: number; newest_updated_at: string | null; columns: CollectionColumn[] } | null> {
    const described = await this.describeCollection(actor, name);
    if (!described) {
      return null;
    }
    const facts = await this.pool.query(
      `SELECT count(*)::int AS count, max(updated_at) AS newest
         FROM artifacts WHERE collection_id = $1 AND kind = 'object' AND deleted_at IS NULL`,
      [described.id],
    );
    const row = facts.rows[0] as { count: number; newest: unknown };
    return {
      name: described.name,
      count: Number(row.count),
      newest_updated_at:
        row.newest instanceof Date
          ? row.newest.toISOString()
          : row.newest
            ? formatOperationalTimestamp(String(row.newest))
            : null,
      columns: described.columns,
    };
  }

  // ---------------------------------------------------------------------------
  // Access: a grant per guild or per agent, read or write.

  /** Every grant on a collection, with the guilds and agents it reaches. */
  async listAccess(
    actor: ArtifactActor,
    collectionId: string,
  ): Promise<{
    guilds: Array<{ id: string; name: string; mode: AccessMode }>;
    agents: Array<{
      id: string;
      name: string;
      guild_id: string;
      guild_name: string;
      guild_mode: AccessMode | null;
      agent_mode: AgentAccessMode | null;
      effective: AccessMode | null;
    }>;
  }> {
    this.assertOperator(actor);
    const collection = await this.loadCollectionById(actor, collectionId);
    if (!collection) {
      throw new ArtifactError("unknown collection", 404);
    }
    if (collection.guild_id) {
      const members = await this.pool.query(
        `SELECT a.id, a.name, a.guild_id, g.name AS guild_name, ag.mode AS agent_mode
           FROM agents a
           JOIN guilds g ON g.id = a.guild_id
           LEFT JOIN collection_access ag
             ON ag.collection_id = $1 AND ag.subject_type = 'agent' AND ag.subject_id = a.id
          WHERE a.guild_id = $2
          ORDER BY a.name`,
        [collection.id, collection.guild_id],
      );
      return {
        guilds: [{ id: collection.guild_id, name: collection.guild_name ?? "", mode: "write" }],
        agents: (members.rows as Array<Record<string, unknown>>).map((row) => {
          const agentMode = (row.agent_mode as AgentAccessMode | null) ?? null;
          return {
            id: String(row.id),
            name: String(row.name),
            guild_id: String(row.guild_id),
            guild_name: String(row.guild_name),
            guild_mode: "write" as const,
            agent_mode: agentMode,
            effective: resolveAccess("write", agentMode),
          };
        }),
      };
    }
    const guilds = await this.pool.query(
      `SELECT g.id, g.name, x.mode
         FROM collection_access x
         JOIN guilds g ON g.id = x.subject_id
        WHERE x.collection_id = $1 AND x.subject_type = 'guild'
        ORDER BY g.name`,
      [collection.id],
    );
    const agents = await this.pool.query(
      `SELECT a.id, a.name, a.guild_id, g.name AS guild_name, ag.mode AS agent_mode, gg.mode AS guild_mode
         FROM agents a
         JOIN guilds g ON g.id = a.guild_id
         LEFT JOIN collection_access ag
           ON ag.collection_id = $1 AND ag.subject_type = 'agent' AND ag.subject_id = a.id
         LEFT JOIN collection_access gg
           ON gg.collection_id = $1 AND gg.subject_type = 'guild' AND gg.subject_id = a.guild_id
        WHERE a.org_id = $2 AND (ag.mode IS NOT NULL OR gg.mode IS NOT NULL)
        ORDER BY g.name, a.name`,
      [collection.id, actor.orgId],
    );
    return {
      guilds: visibleGrants(
        actor,
        (guilds.rows as Array<Record<string, unknown>>).map((row) => ({
          id: String(row.id),
          name: String(row.name),
          mode: String(row.mode) as AccessMode,
        })),
      ),
      agents: visibleGrants(actor, (agents.rows as Array<Record<string, unknown>>).map((row) => {
        const guildMode = (row.guild_mode as AccessMode | null) ?? null;
        const agentMode = (row.agent_mode as AgentAccessMode | null) ?? null;
        return {
          id: String(row.id),
          name: String(row.name),
          guild_id: String(row.guild_id),
          guild_name: String(row.guild_name),
          guild_mode: guildMode,
          agent_mode: agentMode,
          effective: resolveAccess(guildMode, agentMode),
        };
      })),
    };
  }

  /**
   * Writes, replaces, or (with `mode: null`) removes one grant. A guild's
   * own table takes no grants: every agent in that guild writes it and
   * nobody else reaches it.
   */
  async setAccess(
    actor: ArtifactActor,
    args: { collectionId: string; subjectType: unknown; subjectId: string; mode: unknown },
  ): Promise<void> {
    this.assertOperator(actor);
    const collection = await this.loadCollectionById(actor, args.collectionId);
    if (!collection) {
      throw new ArtifactError("unknown collection", 404);
    }
    if (!isAccessSubject(args.subjectType)) {
      throw new ArtifactError("subject_type must be guild or agent", 422);
    }
    const subjectType: AccessSubject = args.subjectType;
    if (collection.guild_id && subjectType === "guild") {
      throw new ArtifactError(
        `${collection.name} belongs to ${collection.guild_name ?? "its guild"}: it is written by that guild and takes no guild grant`,
        422,
      );
    }
    const wanted = args.mode ?? null;
    if (wanted !== null && (subjectType === "guild" ? !isAccessMode(wanted) : !isAgentAccessMode(wanted))) {
      throw new ArtifactError(
        subjectType === "guild" ? "mode must be read, write, or null" : "mode must be none, read, write, or null",
        422,
      );
    }
    const subjectId = String(args.subjectId ?? "").trim();
    const owner = await this.pool.query(
      subjectType === "guild"
        ? `SELECT id FROM guilds WHERE id = $1 AND org_id = $2`
        : `SELECT id, guild_id FROM agents WHERE id = $1 AND org_id = $2`,
      [subjectId, actor.orgId],
    );
    const ownerRow = owner.rows[0] as { id: string; guild_id?: string } | undefined;
    if (!ownerRow || visibleGrants(actor, [ownerRow]).length === 0) {
      throw new ArtifactError(`unknown ${subjectType}`, 404);
    }
    if (collection.guild_id && String((owner.rows[0] as { guild_id?: string }).guild_id ?? "") !== collection.guild_id) {
      throw new ArtifactError(
        `${collection.name} belongs to ${collection.guild_name ?? "its guild"}: only an agent of that guild reaches it`,
        422,
      );
    }
    if (wanted === null) {
      await this.pool.query(
        `DELETE FROM collection_access WHERE collection_id = $1 AND subject_type = $2 AND subject_id = $3`,
        [collection.id, subjectType, subjectId],
      );
      return;
    }
    await this.pool.query(
      `INSERT INTO collection_access (
         id, org_id, collection_id, subject_type, subject_id, mode,
         created_by_type, created_by_id, created_by_name, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (collection_id, subject_type, subject_id)
       DO UPDATE SET mode = EXCLUDED.mode, created_by_type = EXCLUDED.created_by_type,
                     created_by_id = EXCLUDED.created_by_id, created_by_name = EXCLUDED.created_by_name,
                     created_at = EXCLUDED.created_at`,
      [
        newId("cacc"),
        actor.orgId,
        collection.id,
        subjectType,
        subjectId,
        wanted,
        actor.actorType,
        actor.actorId,
        actor.actorName,
        stamp(new Date()),
      ],
    );
  }

  /**
   * Every live table a guild can be given: its own tables (always `write`,
   * `scope: "guild"`) and the organisation tables with the guild's grant.
   * Other guilds' tables are left out.
   */
  async accessForGuild(
    actor: ArtifactActor,
    guildId: string,
  ): Promise<Array<{ collection_id: string; name: string; purpose: string; scope: "guild" | "org"; mode: AccessMode | null }>> {
    this.assertOperator(actor);
    const result = await this.pool.query(
      `SELECT c.id, c.name, c.purpose, c.guild_id, x.mode
         FROM artifact_collections c
         LEFT JOIN collection_access x
           ON x.collection_id = c.id AND x.subject_type = 'guild' AND x.subject_id = $2
        WHERE c.org_id = $1 AND c.deleted_at IS NULL AND (c.guild_id IS NULL OR c.guild_id = $2)
        ORDER BY c.guild_id IS NULL, c.name`,
      [actor.orgId, guildId],
    );
    return (result.rows as Array<Record<string, unknown>>).map((row) => ({
      collection_id: String(row.id),
      name: String(row.name),
      purpose: String(row.purpose),
      scope: row.guild_id ? "guild" : "org",
      mode: row.guild_id ? "write" : ((row.mode as AccessMode | null) ?? null),
    }));
  }

  /**
   * Every live table an agent can be given: the organisation tables with its
   * guild's base mode, and its guild's own tables, whose base is `write`.
   * `agent_mode` is this agent's override (`none` keeps it out) and
   * `effective` is what the agent ends up with.
   */
  async accessForAgent(
    actor: ArtifactActor,
    agentId: string,
    guildId: string,
  ): Promise<
    Array<{
      collection_id: string;
      name: string;
      purpose: string;
      scope: "guild" | "org";
      guild_mode: AccessMode | null;
      agent_mode: AgentAccessMode | null;
      effective: AccessMode | null;
    }>
  > {
    this.assertOperator(actor);
    const result = await this.pool.query(
      `SELECT c.id, c.name, c.purpose, c.guild_id, ag.mode AS agent_mode, gg.mode AS guild_mode
         FROM artifact_collections c
         LEFT JOIN collection_access ag
           ON ag.collection_id = c.id AND ag.subject_type = 'agent' AND ag.subject_id = $2
         LEFT JOIN collection_access gg
           ON gg.collection_id = c.id AND gg.subject_type = 'guild' AND gg.subject_id = $3
        WHERE c.org_id = $1 AND c.deleted_at IS NULL AND (c.guild_id IS NULL OR c.guild_id = $3)
        ORDER BY c.guild_id IS NULL, c.name`,
      [actor.orgId, agentId, guildId],
    );
    return (result.rows as Array<Record<string, unknown>>).map((row) => {
      const guildMode = row.guild_id ? ("write" as const) : ((row.guild_mode as AccessMode | null) ?? null);
      const agentMode = (row.agent_mode as AgentAccessMode | null) ?? null;
      return {
        collection_id: String(row.id),
        name: String(row.name),
        purpose: String(row.purpose),
        scope: row.guild_id ? ("guild" as const) : ("org" as const),
        guild_mode: guildMode,
        agent_mode: agentMode,
        effective: resolveAccess(guildMode, agentMode),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Records.

  /**
   * Adds a record. The body is validated against the columns and rejected
   * with every problem at once; the store assigns the id. When the unique
   * column matches a live record, the body is merged into that record
   * instead and `merged` carries its id.
   */
  async addRecord(
    actor: ArtifactActor,
    args: { collection: string; body: Record<string, unknown> },
  ): Promise<{ record: RecordView; merged: number | null }> {
    const collection = await this.requireWritable(actor, args.collection);
    const checked = validateAdd(collection.columns, args.body);
    if (checked.problems.length) {
      throw recordRejected(checked.problems);
    }
    const body = checked.body;
    this.assertBytes(JSON.stringify(body));
    const identity = identityFor(collection.columns, body);
    return withTransaction(this.pool, async (client) => {
      const locked = await client.query(
        `SELECT next_id FROM artifact_collections WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [collection.id],
      );
      const lockedRow = locked.rows[0] as { next_id: number } | undefined;
      if (!lockedRow) {
        throw new ArtifactError("unknown collection", 404);
      }
      if (identity !== null) {
        const existing = await client.query(
          `SELECT ${ARTIFACT_SELECT}
             FROM artifacts a
             LEFT JOIN artifact_collections c ON c.id = a.collection_id
            WHERE a.collection_id = $1 AND a.kind = 'object' AND a.deleted_at IS NULL AND a.identity = $2
            FOR UPDATE OF a
            LIMIT 1`,
          [collection.id, identity],
        );
        const live = existing.rows[0] as Record<string, unknown> | undefined;
        if (live) {
          const current = mapRow(live);
          const merged = { ...bodyOf(current), ...body };
          const row = await this.writeRecordRow(client, actor, collection, current, merged, identity);
          return { record: this.recordView(row), merged: Number(row.key) };
        }
      }
      const count = await client.query(
        `SELECT COUNT(*)::int AS n FROM artifacts WHERE collection_id = $1 AND kind = 'object' AND deleted_at IS NULL`,
        [collection.id],
      );
      if (Number(count.rows[0]?.n ?? 0) >= LIVE_RECORDS_MAX) {
        throw new ArtifactError("record limit reached", 422);
      }
      const id = Number(lockedRow.next_id);
      const key = String(id);
      const now = stamp(new Date());
      let inserted;
      try {
        inserted = await client.query(
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
            actor.orgId,
            actor.guildId,
            collection.id,
            key,
            JSON.stringify(body),
            contentHash(null, body),
            actor.actorType,
            actor.actorId,
            actor.actorName,
            now,
            searchBlobFor(key, body),
            identity,
          ],
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ArtifactError(uniqueConflictMessage(collection.columns), 409);
        }
        throw error;
      }
      await client.query(`UPDATE artifact_collections SET next_id = $2 WHERE id = $1`, [collection.id, id + 1]);
      const row = mapReturned(inserted.rows[0] as Record<string, unknown>, collection.name);
      await recordFileChange(client, actor, {
        orgId: row.org_id,
        artifactId: row.id,
        displayPath: displayPathFor(rowAsDisplay(row)),
        operation: "create",
        version: row.version,
      });
      return { record: this.recordView(row), merged: null };
    });
  }

  /**
   * Merges a patch into a record. The patched columns are validated; the
   * rest of the record is checked afterwards and its pre-existing problems
   * are returned as warnings without rejecting the write.
   */
  async updateRecord(
    actor: ArtifactActor,
    args: { collection: string; id: unknown; body: Record<string, unknown> },
  ): Promise<{ record: RecordView; warnings: string[] }> {
    const collection = await this.requireWritable(actor, args.collection);
    const id = parseRecordId(args.id);
    const checked = validatePatch(collection.columns, args.body);
    if (checked.problems.length) {
      throw recordRejected(checked.problems);
    }
    return withTransaction(this.pool, async (client) => {
      const current = await this.lockRecord(client, collection.id, id);
      const merged: Record<string, unknown> = { ...bodyOf(current) };
      for (const name of checked.clear) {
        delete merged[name];
      }
      Object.assign(merged, checked.set);
      this.assertBytes(JSON.stringify(merged));
      const identity = identityFor(collection.columns, merged);
      if (identity !== null) {
        const other = await client.query(
          `SELECT key FROM artifacts
            WHERE collection_id = $1 AND kind = 'object' AND deleted_at IS NULL AND identity = $2 AND id <> $3
            LIMIT 1`,
          [collection.id, identity, current.id],
        );
        const clash = other.rows[0] as { key: string } | undefined;
        if (clash) {
          throw new ArtifactError(
            `${uniqueConflictMessage(collection.columns)}: record ${clash.key} already holds that value`,
            409,
          );
        }
      }
      const row = await this.writeRecordRow(client, actor, collection, current, merged, identity);
      const touched = new Set([...Object.keys(checked.set), ...checked.clear]);
      const warnings = recordProblems(collection.columns, merged).filter(
        (problem) => !touched.has(problemColumn(problem)),
      );
      return { record: this.recordView(row), warnings };
    });
  }

  async removeRecord(actor: ArtifactActor, args: { collection: string; id: unknown }): Promise<number> {
    const collection = await this.requireWritable(actor, args.collection);
    const id = parseRecordId(args.id);
    return withTransaction(this.pool, async (client) => {
      const current = await this.lockRecord(client, collection.id, id);
      const now = new Date();
      const result = await client.query(
        `UPDATE artifacts
            SET deleted_at = $2, updated_by_type = $3, updated_by_id = $4, updated_by_name = $5, updated_at = $2
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING version`,
        [current.id, stamp(now), actor.actorType, actor.actorId, actor.actorName],
      );
      if (!result.rows[0]) {
        throw new ArtifactError("record not found", 404);
      }
      await recordFileChange(client, actor, {
        orgId: current.org_id,
        artifactId: current.id,
        displayPath: displayPathFor(rowAsDisplay(current)),
        operation: "delete",
        version: Number(result.rows[0].version),
        createdAt: now,
      });
      return id;
    });
  }

  async getRecord(actor: ArtifactActor, collectionName: string, id: unknown): Promise<RecordView> {
    const collection = await this.requireReadable(actor, collectionName);
    const row = await this.loadRecord(this.pool, collection.id, parseRecordId(id));
    if (!row) {
      throw new ArtifactError("record not found", 404);
    }
    return this.recordView(row);
  }

  /**
   * Records of one collection narrowed by `where` (a term per column, matched
   * by the column's type), `since` (changed at or after a moment), ordered
   * by `order` (default id; with `since`, default oldest change first), and
   * paged by `limit` and `offset`. `total` counts every match regardless of
   * paging.
   */
  async listRecords(
    actor: ArtifactActor,
    args: { collection: string; where?: unknown; since?: unknown; order?: unknown; limit?: unknown; offset?: unknown },
  ): Promise<{ total: number; records: RecordView[]; columns: CollectionColumn[] }> {
    const collection = await this.requireReadable(actor, args.collection);
    const where = parseWhere(args.where, collection.columns);
    const since = parseSince(args.since);
    const order = parseOrder(args.order, collection.columns);
    const limit = parseLimit(args.limit, FIND_DEFAULT, FIND_MAX);
    const offset = parseOffset(args.offset);
    const values: unknown[] = [collection.id];
    let filter = `a.collection_id = $1 AND a.kind = 'object' AND a.deleted_at IS NULL`;
    for (const clause of where) {
      filter += ` AND ${whereClauseSql(clause, values).where}`;
    }
    if (since) {
      values.push(since);
      filter += ` AND a.updated_at >= $${values.length}`;
    }
    const total = await this.pool.query(`SELECT count(*)::int AS n FROM artifacts a WHERE ${filter}`, values);
    const orderSql = orderClauseSql(order ?? (since ? { column: "updated_at", direction: "asc" } : { column: "id", direction: "asc" }), collection.columns, values);
    values.push(limit);
    const limitIndex = values.length;
    values.push(offset);
    const result = await this.pool.query(
      `SELECT ${ARTIFACT_SELECT}
         FROM artifacts a
         LEFT JOIN artifact_collections c ON c.id = a.collection_id
        WHERE ${filter}
        ORDER BY ${orderSql}
        LIMIT $${limitIndex} OFFSET $${values.length}`,
      values,
    );
    return {
      total: Number((total.rows[0] as { n: number }).n),
      records: (result.rows as Array<Record<string, unknown>>).map((row) => this.recordView(mapRow(row))),
      columns: collection.columns,
    };
  }

  /**
   * Text search over the records the actor can read: whole words through
   * the tsvector with the websearch grammar, a single token also by
   * substring. With `collection`, `where` narrows the hits by column.
   */
  async searchRecords(
    actor: ArtifactActor,
    args: { collection?: string; query: string; where?: unknown; limit?: unknown },
  ): Promise<{ records: RecordView[] }> {
    const query = (args.query ?? "").trim();
    if (!query) {
      throw new ArtifactError("query is required", 422);
    }
    const limit = parseLimit(args.limit, FIND_DEFAULT, FIND_MAX);
    const values: unknown[] = [];
    let scope: string;
    let where: WhereClause[] = [];
    if (args.collection) {
      const collection = await this.requireReadable(actor, args.collection);
      where = parseWhere(args.where, collection.columns);
      values.push(collection.id);
      scope = `a.collection_id = $1`;
    } else {
      if (args.where !== undefined && args.where !== null) {
        throw new ArtifactError("where needs a collection", 422);
      }
      scope = this.readableCollectionsSql(actor, values);
    }
    let sql = `SELECT ${ARTIFACT_SELECT}
         FROM artifacts a
         JOIN artifact_collections c ON c.id = a.collection_id AND c.deleted_at IS NULL
        WHERE a.kind = 'object' AND a.deleted_at IS NULL AND ${scope}`;
    const text = objectQuerySql(query, values);
    sql += ` AND ${text.where}`;
    const scores = [text.score];
    for (const clause of where) {
      const built = whereClauseSql(clause, values);
      sql += ` AND ${built.where}`;
      if (built.score) scores.push(built.score);
    }
    values.push(limit);
    sql += ` ORDER BY (${scores.join(" + ")}) DESC, a.updated_at DESC LIMIT $${values.length}`;
    const result = await this.pool.query(sql, values);
    return {
      records: (result.rows as Array<Record<string, unknown>>).map((row) => this.recordView(mapRow(row))),
    };
  }

  /** Every live record of a collection, in id order, for an export. */
  async exportRecords(actor: ArtifactActor, collectionId: string): Promise<{ name: string; records: RecordView[] }> {
    const collection = await this.loadCollectionById(actor, collectionId);
    if (!collection || !(await this.accessMode(actor, collection))) {
      throw new ArtifactError("unknown collection", 404);
    }
    const result = await this.pool.query(
      `SELECT ${ARTIFACT_SELECT}
         FROM artifacts a
         LEFT JOIN artifact_collections c ON c.id = a.collection_id
        WHERE a.collection_id = $1 AND a.kind = 'object' AND a.deleted_at IS NULL
        ORDER BY length(a.key), a.key
        LIMIT $2`,
      [collection.id, LIVE_RECORDS_MAX],
    );
    return {
      name: collection.name,
      records: (result.rows as Array<Record<string, unknown>>).map((row) => this.recordView(mapRow(row))),
    };
  }

  // ---------------------------------------------------------------------------
  // Display paths shared by notes, memory, and records.

  async deleteByDisplayPath(actor: ArtifactActor, displayPath: string): Promise<void> {
    const parsed = parseDisplayPath(displayPath);
    if (parsed.kind === "revision") {
      throw new ArtifactError("history-archive is read-only", 422);
    }
    if (parsed.kind === "collection") {
      if (parsed.orgId !== actor.orgId) {
        throw new ArtifactError("artifact not found", 404);
      }
      const collection = await this.loadCollectionByName(actor, parsed.collectionName);
      if (!collection) {
        throw new ArtifactError("unknown collection", 404);
      }
      await this.deleteCollection(actor, collection.id);
      return;
    }
    if (parsed.kind === "record") {
      if (parsed.orgId !== actor.orgId) {
        throw new ArtifactError("artifact not found", 404);
      }
      await this.removeRecord(actor, { collection: parsed.collectionName, id: parsed.recordId });
      return;
    }
    if (parsed.level === "agent" && parsed.path === "" && parsed.key === TASK_KEY) {
      throw new ArtifactError("cannot delete this file", 422);
    }
    const row = await this.loadParsed(parsed);
    if (!row) {
      throw new ArtifactError("artifact not found", 404);
    }
    this.assertRead(actor, row);
    this.assertWriteLevel(actor, row.level);
    if (row.kind === "memory") {
      throw new ArtifactError("cannot delete this file", 422);
    }
    await this.assertNotEmbedded(actor.orgId, displayPathFor(rowAsDisplay(row)));
    await withTransaction(this.pool, async (client) => {
      const now = new Date();
      const result = await client.query(
        `UPDATE artifacts
            SET deleted_at = $2, updated_by_type = $3, updated_by_id = $4,
                updated_by_name = $5, updated_at = $2
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING version`,
        [row.id, stamp(now), actor.actorType, actor.actorId, actor.actorName],
      );
      if (!result.rows[0]) {
        throw new ArtifactError("artifact not found", 404);
      }
      await recordFileChange(client, actor, {
        orgId: row.org_id,
        artifactId: row.id,
        displayPath: displayPathFor(rowAsDisplay(row)),
        operation: "delete",
        version: Number(result.rows[0].version),
        createdAt: now,
      });
    });
  }

  async getByDisplayPath(
    actor: ArtifactActor,
    displayPath: string,
  ): Promise<{ row?: ArtifactRow; revision?: { content: string; display_path: string }; tombstone?: boolean }> {
    const parsed = parseDisplayPath(displayPath);
    if (parsed.kind === "revision") {
      if (!actor.operator || !this.canReadLevel(actor, "agent", parsed.agentId)) {
        throw new ArtifactError("artifact not found", 404);
      }
      const result = await this.pool.query(
        `SELECT content_text, replaced_at, replaced_by_name
           FROM memory_revisions
          WHERE org_id = $1 AND agent_id = $2
            AND concat(to_char(replaced_at AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS'), '-',
                       regexp_replace(replaced_by_name, '[/:]', '-', 'g'), '.md') = $3
          LIMIT 1`,
        [parsed.orgId, parsed.agentId, parsed.stamp],
      );
      const hit = result.rows[0] as { content_text?: string } | undefined;
      if (!hit?.content_text) {
        const listed = await this.listRevisions(actor, parsed.agentId);
        const match = listed.find((item) => item.display_path.endsWith(`/${parsed.stamp}`));
        if (!match) {
          throw new ArtifactError("artifact not found", 404);
        }
        return { revision: match };
      }
      return {
        revision: {
          content: hit.content_text,
          display_path: revisionDisplayPath(parsed.orgId, parsed.agentId, parsed.stamp),
        },
      };
    }
    if (parsed.kind === "collection") {
      throw new ArtifactError("artifact not found", 404);
    }
    if (parsed.kind === "record") {
      if (parsed.orgId !== actor.orgId) {
        throw new ArtifactError("artifact not found", 404);
      }
      const collection = await this.requireReadable(actor, parsed.collectionName);
      const row = await this.loadRecord(this.pool, collection.id, parseRecordId(parsed.recordId), true);
      if (!row) {
        throw new ArtifactError("artifact not found", 404);
      }
      return row.deleted_at ? { tombstone: true, row } : { row };
    }
    const includingDeleted = await this.loadParsed(parsed, true);
    if (!includingDeleted) {
      throw new ArtifactError("artifact not found", 404);
    }
    this.assertRead(actor, includingDeleted);
    if (includingDeleted.deleted_at) {
      return { tombstone: true, row: includingDeleted };
    }
    return { row: includingDeleted };
  }

  /** Whether the actor may read what a display path names, so its change history may be shown. */
  async canReadDisplayPath(actor: ArtifactActor, displayPath: string): Promise<boolean> {
    const parsed = isDisplayPath(displayPath) ? parseDisplayPath(displayPath) : null;
    if (parsed?.orgId !== actor.orgId) {
      return false;
    }
    if ("collectionName" in parsed) {
      return (await this.describeCollection(actor, parsed.collectionName)) !== null;
    }
    const owner = fileOwner(parsed);
    return this.canReadLevel(actor, owner.level, owner.ownerId);
  }

  /** Notes the actor may read, searched by `query` or listed, optionally at one level. */
  async find(
    actor: ArtifactActor,
    args: {
      query?: string;
      level?: ArtifactLevel;
      limit?: number;
    },
  ): Promise<{ notes: Array<Record<string, unknown>> }> {
    const limit = Math.min(Math.max(args.limit ?? FIND_DEFAULT, 1), FIND_MAX);
    const query = (args.query ?? "").trim();
    const rows = query ? await this.searchNotes(actor, query, args.level, limit) : await this.listNotes(actor, args.level, limit);
    return { notes: rows.map((row) => this.view(row)) };
  }

  /** The notes one owner holds, as the Host lists them. */
  async listOwnerNotes(
    actor: ArtifactActor,
    level: ArtifactLevel,
    ownerId: string,
  ): Promise<Array<Record<string, unknown>>> {
    if (!this.canReadLevel(actor, level, ownerId)) {
      return [];
    }
    const result = await this.pool.query(
      `SELECT ${ARTIFACT_SELECT}
         FROM artifacts a
         LEFT JOIN artifact_collections c ON c.id = a.collection_id
        WHERE a.org_id = $1 AND a.level = $2 AND a.owner_id = $3 AND a.deleted_at IS NULL
          AND a.kind = 'note'
        ORDER BY a.key`,
      [actor.orgId, level, ownerId],
    );
    return (result.rows as Array<Record<string, unknown>>).map((row) => this.fileView(mapRow(row)));
  }

  /** Previous memory versions, newest first. Only the operator reads them; agents never see the archive. */
  async listRevisions(actor: ArtifactActor, agentId: string): Promise<MemoryRevisionRow[]> {
    if (!actor.operator || !this.canReadLevel(actor, "agent", agentId)) {
      return [];
    }
    const result = await this.pool.query(
      `SELECT id, content_text, replaced_at, replaced_by_type, replaced_by_id, replaced_by_name, replaced_by_detail
         FROM memory_revisions
        WHERE org_id = $1 AND agent_id = $2
        ORDER BY replaced_at DESC, id DESC`,
      [actor.orgId, agentId],
    );
    return (result.rows as Array<Record<string, unknown>>).map((row) => {
      const replacedAt =
        row.replaced_at instanceof Date ? row.replaced_at.toISOString() : formatColumnTimestamp(String(row.replaced_at));
      const stampName = archiveStamp(replacedAt, String(row.replaced_by_name));
      return {
        id: String(row.id),
        content: String(row.content_text),
        display_path: revisionDisplayPath(actor.orgId, agentId, stampName),
        path: `${HISTORY_ARCHIVE_SEGMENT}/${stampName}`,
        replaced_at: replacedAt,
        replaced_by: {
          type: String(row.replaced_by_type) as MemoryRevisionRow["replaced_by"]["type"],
          id: String(row.replaced_by_id),
          name: String(row.replaced_by_name),
          detail: String(row.replaced_by_detail ?? ""),
        },
      };
    });
  }

  async listEmbeddableNotes(actor: ArtifactActor): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT ${ARTIFACT_SELECT}
         FROM artifacts a
         LEFT JOIN artifact_collections c ON c.id = a.collection_id
        WHERE a.org_id = $1 AND a.kind = 'note' AND a.deleted_at IS NULL
        ORDER BY a.level, a.key
        LIMIT 500`,
      [actor.orgId],
    );
    return (result.rows as Array<Record<string, unknown>>)
      .map((row) => mapRow(row))
      .filter((row) => this.canReadRow(actor, row))
      .map((row) => this.view(row));
  }

  view(row: ArtifactRow): Record<string, unknown> {
    if (row.kind === "object") {
      return this.recordView(row, { displayPath: true });
    }
    const display_path = displayPathFor(rowAsDisplay(row));
    return {
      display_path,
      kind: row.kind,
      level: row.level,
      key: row.key,
      title: row.title,
      author: row.updated_by_name,
      version: row.version,
      updated_at: formatOperationalTimestamp(String(row.updated_at)),
      content: row.content_text,
    };
  }

  /**
   * A record as tools and the API return it: the id, the declared columns,
   * then the system columns from the row.
   */
  recordView(row: ArtifactRow, options: { displayPath?: boolean } = {}): RecordView {
    const view: RecordView = { id: Number(row.key), collection: row.collection_name };
    if (options.displayPath) {
      view.display_path = displayPathFor(rowAsDisplay(row));
    }
    Object.assign(view, bodyOf(row));
    view.created_at = formatOperationalTimestamp(String(row.created_at));
    view.updated_at = formatOperationalTimestamp(String(row.updated_at));
    view.updated_by = row.updated_by_name;
    view.version = row.version;
    return view;
  }

  /** A note as the Host lists it: `path` is its file name. */
  fileView(row: ArtifactRow): Record<string, unknown> {
    return {
      path: row.key,
      display_path: displayPathFor(rowAsDisplay(row)),
      kind: row.kind,
      title: row.title,
      version: row.version,
    };
  }

  canReadLevel(actor: ArtifactActor, level: ArtifactLevel, ownerId: string): boolean {
    if (actor.orgId === "" || ownerId === "") {
      return false;
    }
    if (actor.operator) {
      return !isHiddenOwner(actor, level, ownerId);
    }
    if (level === "org") {
      return actor.grants.readOrg;
    }
    if (level === "guild") {
      return actor.grants.readGuild && actor.guildId === ownerId;
    }
    return actor.agentId === ownerId;
  }

  // ---------------------------------------------------------------------------
  // Private helpers.

  private assertOperator(actor: ArtifactActor): void {
    if (!actor.operator) {
      throw new ArtifactError("collections are managed by the operator", 403);
    }
  }

  private async requireReadable(actor: ArtifactActor, name: string): Promise<CollectionDescription> {
    const described = await this.describeCollection(actor, name);
    if (!described) {
      throw new ArtifactError(`unknown collection ${String(name ?? "").trim() || "(empty)"}`, 404);
    }
    return described;
  }

  private async requireWritable(actor: ArtifactActor, name: string): Promise<CollectionDescription> {
    const described = await this.requireReadable(actor, name);
    if (described.access !== "write") {
      throw new ArtifactError(`no write access to ${described.name}`, 403);
    }
    return described;
  }

  /**
   * The actor's mode on a collection: its guild's base mode, `write` on the
   * guild's own table, replaced by this agent's override when it has one.
   * The operator writes everything.
   */
  private async accessMode(actor: ArtifactActor, collection: CollectionRow): Promise<AccessMode | null> {
    if (actor.operator) {
      return "write";
    }
    if (collection.guild_id && actor.guildId !== collection.guild_id) {
      return null;
    }
    const result = await this.pool.query(
      `SELECT subject_type, mode FROM collection_access
        WHERE collection_id = $1
          AND ((subject_type = 'agent' AND subject_id = $2) OR (subject_type = 'guild' AND subject_id = $3))`,
      [collection.id, actor.agentId ?? "", actor.guildId ?? ""],
    );
    const rows = result.rows as Array<{ subject_type: string; mode: string }>;
    const base = collection.guild_id
      ? ("write" as AccessMode)
      : (() => {
          const row = rows.find((item) => item.subject_type === "guild");
          return row && isAccessMode(row.mode) ? row.mode : null;
        })();
    const override = rows.find((item) => item.subject_type === "agent");
    return resolveAccess(base, override && isAgentAccessMode(override.mode) ? override.mode : null);
  }

  private async accessibleCollections(actor: ArtifactActor): Promise<Array<{ row: CollectionRow; mode: AccessMode }>> {
    if (actor.operator) {
      const result = await this.pool.query(
        `SELECT ${COLLECTION_SELECT} FROM artifact_collections
          WHERE org_id = $1 AND deleted_at IS NULL
            AND (guild_id IS NULL OR guild_id <> ALL($2::text[]))
          ORDER BY name`,
        [actor.orgId, actor.hidden.guildIds],
      );
      return (result.rows as Array<Record<string, unknown>>).map((row) => ({ row: mapCollection(row), mode: "write" }));
    }
    const result = await this.pool.query(
      `SELECT ${COLLECTION_SELECT}, ag.mode AS agent_mode, gg.mode AS guild_mode
         FROM artifact_collections
         LEFT JOIN collection_access ag ON ag.collection_id = artifact_collections.id
          AND ag.subject_type = 'agent' AND ag.subject_id = $2
         LEFT JOIN collection_access gg ON gg.collection_id = artifact_collections.id
          AND gg.subject_type = 'guild' AND gg.subject_id = $3
        WHERE artifact_collections.org_id = $1 AND artifact_collections.deleted_at IS NULL
          AND (artifact_collections.guild_id = $3
               OR (artifact_collections.guild_id IS NULL AND (gg.id IS NOT NULL OR ag.id IS NOT NULL)))
        ORDER BY artifact_collections.name`,
      [actor.orgId, actor.agentId ?? "", actor.guildId ?? ""],
    );
    return (result.rows as Array<Record<string, unknown>>).flatMap((row) => {
      const mapped = mapCollection(row);
      const base = mapped.guild_id ? ("write" as AccessMode) : isAccessMode(row.guild_mode) ? row.guild_mode : null;
      const override = isAgentAccessMode(row.agent_mode) ? row.agent_mode : null;
      const mode = resolveAccess(base, override);
      return mode ? [{ row: mapped, mode }] : [];
    });
  }

  /** The predicate over `a.collection_id` for every collection the actor can read. */
  private readableCollectionsSql(actor: ArtifactActor, values: unknown[]): string {
    values.push(actor.orgId);
    const org = values.length;
    if (actor.operator) {
      values.push(actor.hidden.guildIds);
      return `c.org_id = $${org} AND (c.guild_id IS NULL OR c.guild_id <> ALL($${values.length}::text[]))`;
    }
    values.push(actor.agentId ?? "");
    const agent = values.length;
    values.push(actor.guildId ?? "");
    const guild = values.length;
    const override = `(SELECT x.mode FROM collection_access x
         WHERE x.collection_id = a.collection_id AND x.subject_type = 'agent' AND x.subject_id = $${agent})`;
    const base = `(SELECT x.mode FROM collection_access x
         WHERE x.collection_id = a.collection_id AND x.subject_type = 'guild' AND x.subject_id = $${guild})`;
    return `c.org_id = $${org}
      AND (c.guild_id = $${guild} OR (c.guild_id IS NULL AND COALESCE(${override}, ${base}) IS NOT NULL))
      AND COALESCE(${override}, 'inherit') <> 'none'`;
  }

  private async requireGuild(actor: ArtifactActor, guildId: string): Promise<string> {
    const id = String(guildId ?? "").trim();
    const result = await this.pool.query(`SELECT id FROM guilds WHERE id = $1 AND org_id = $2`, [id, actor.orgId]);
    if (!result.rows[0] || actor.hidden.guildIds.includes(id)) {
      throw new ArtifactError("unknown guild", 404);
    }
    return id;
  }

  private collectionView(row: CollectionRow, access: AccessMode, count?: number): CollectionView {
    return {
      id: row.id,
      name: row.name,
      purpose: row.purpose,
      columns: row.columns,
      display_path: collectionDisplayPath(row.org_id, row.name),
      scope: row.guild_id ? "guild" : "org",
      guild: row.guild_id ? { id: row.guild_id, name: row.guild_name ?? "" } : null,
      access,
      created_at: formatOperationalTimestamp(String(row.created_at)),
      updated_at: formatOperationalTimestamp(String(row.updated_at)),
      ...(count !== undefined ? { count } : {}),
    };
  }

  private async countRecords(collectionId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT count(*)::int AS n FROM artifacts WHERE collection_id = $1 AND kind = 'object' AND deleted_at IS NULL`,
      [collectionId],
    );
    return Number((result.rows[0] as { n: number }).n);
  }

  private async countByCollection(ids: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (!ids.length) {
      return counts;
    }
    const result = await this.pool.query(
      `SELECT collection_id, count(*)::int AS n FROM artifacts
        WHERE collection_id = ANY($1::text[]) AND kind = 'object' AND deleted_at IS NULL
        GROUP BY collection_id`,
      [ids],
    );
    for (const row of result.rows as Array<{ collection_id: string; n: number }>) {
      counts.set(String(row.collection_id), Number(row.n));
    }
    return counts;
  }

  private async loadCollectionById(actor: ArtifactActor, collectionId: string): Promise<CollectionRow | null> {
    const result = await this.pool.query(
      `SELECT ${COLLECTION_SELECT} FROM artifact_collections WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [actor.orgId, collectionId],
    );
    return visibleCollection(actor, result.rows[0] as Record<string, unknown> | undefined);
  }

  private async loadCollectionByName(actor: ArtifactActor, name: string): Promise<CollectionRow | null> {
    const result = await this.pool.query(
      `SELECT ${COLLECTION_SELECT} FROM artifact_collections WHERE org_id = $1 AND name = $2 AND deleted_at IS NULL`,
      [actor.orgId, name],
    );
    return visibleCollection(actor, result.rows[0] as Record<string, unknown> | undefined);
  }

  /** Recomputes `identity` for every live record; refuses when values repeat. */
  private async reindexIdentity(client: Queryable, collectionId: string, unique: CollectionColumn): Promise<void> {
    const rows = await client.query(
      `SELECT id, key, content_json FROM artifacts
        WHERE collection_id = $1 AND kind = 'object' AND deleted_at IS NULL`,
      [collectionId],
    );
    const seen = new Map<string, string>();
    const duplicates = new Set<string>();
    const updates: Array<[string, string | null]> = [];
    for (const row of rows.rows as Array<{ id: string; key: string; content_json: unknown }>) {
      const body = row.content_json && typeof row.content_json === "object" ? (row.content_json as Record<string, unknown>) : {};
      const identity = normalizeIdentity(unique, body[unique.name]);
      if (identity !== null) {
        const previous = seen.get(identity);
        if (previous) {
          duplicates.add(String(body[unique.name]));
        } else {
          seen.set(identity, row.key);
        }
      }
      updates.push([row.id, identity]);
    }
    if (duplicates.size) {
      throw new ArtifactError(
        `column "${unique.name}" cannot be unique while live records repeat: ${[...duplicates].slice(0, 20).join(", ")}`,
        409,
      );
    }
    await client.query(
      `UPDATE artifacts SET identity = NULL WHERE collection_id = $1 AND kind = 'object' AND identity IS NOT NULL`,
      [collectionId],
    );
    for (const [id, identity] of updates) {
      if (identity !== null) {
        await client.query(`UPDATE artifacts SET identity = $2 WHERE id = $1`, [id, identity]);
      }
    }
  }

  private async loadRecord(
    db: Queryable,
    collectionId: string,
    id: number,
    includeDeleted = false,
  ): Promise<(ArtifactRow & { deleted_at?: string | null }) | null> {
    const deleted = includeDeleted ? "" : "AND a.deleted_at IS NULL";
    const result = await db.query(
      `SELECT ${ARTIFACT_SELECT}, a.deleted_at
         FROM artifacts a
         LEFT JOIN artifact_collections c ON c.id = a.collection_id
        WHERE a.collection_id = $1 AND a.kind = 'object' AND a.key = $2 ${deleted}
        ORDER BY a.deleted_at NULLS FIRST
        LIMIT 1`,
      [collectionId, String(id)],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? { ...mapRow(row), deleted_at: (row.deleted_at as string | null) ?? null } : null;
  }

  private async lockRecord(client: Queryable, collectionId: string, id: number): Promise<ArtifactRow> {
    const result = await client.query(
      `SELECT ${ARTIFACT_SELECT}
         FROM artifacts a
         LEFT JOIN artifact_collections c ON c.id = a.collection_id
        WHERE a.collection_id = $1 AND a.kind = 'object' AND a.key = $2 AND a.deleted_at IS NULL
        FOR UPDATE OF a
        LIMIT 1`,
      [collectionId, String(id)],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new ArtifactError(`record ${id} not found`, 404);
    }
    return mapRow(row);
  }

  private async writeRecordRow(
    client: Queryable,
    actor: ArtifactActor,
    collection: CollectionDescription,
    current: ArtifactRow,
    body: Record<string, unknown>,
    identity: string | null,
  ): Promise<ArtifactRow> {
    let result;
    try {
      result = await client.query(
        `UPDATE artifacts
            SET content_json = $2::jsonb, search_blob = $3, identity = $4, content_hash = $5, version = version + 1,
                updated_by_type = $6, updated_by_id = $7, updated_by_name = $8, updated_at = $9
          WHERE id = $1
          RETURNING ${ARTIFACT_RETURNING}`,
        [
          current.id,
          JSON.stringify(body),
          searchBlobFor(current.key, body),
          identity,
          contentHash(null, body),
          actor.actorType,
          actor.actorId,
          actor.actorName,
          stamp(new Date()),
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ArtifactError(uniqueConflictMessage(collection.columns), 409);
      }
      throw error;
    }
    const row = mapReturned(result.rows[0] as Record<string, unknown>, collection.name);
    await recordFileChange(client, actor, {
      orgId: row.org_id,
      artifactId: row.id,
      displayPath: displayPathFor(rowAsDisplay(row)),
      operation: "update",
      version: row.version,
    });
    return row;
  }

  private canReadRow(actor: ArtifactActor, row: ArtifactRow): boolean {
    if (row.org_id !== actor.orgId) {
      return false;
    }
    return this.canReadLevel(actor, row.level, row.owner_id);
  }

  private assertRead(actor: ArtifactActor, row: ArtifactRow & { deleted_at?: string | null }): void {
    if (!this.canReadRow(actor, row)) {
      throw new ArtifactError("artifact not found", 404);
    }
  }

  private assertWriteLevel(actor: ArtifactActor, level: ArtifactLevel): void {
    if (actor.operator) {
      return;
    }
    if (level === "agent") {
      if (!actor.agentId) throw new ArtifactError("write not allowed", 422);
      return;
    }
    if (level === "guild" && actor.grants.writeGuild && actor.guildId) {
      return;
    }
    if (level === "org" && actor.grants.writeOrg) {
      return;
    }
    throw new ArtifactError("write not allowed", 422);
  }

  private ownerFor(
    actor: ArtifactActor,
    level: ArtifactLevel,
  ): { orgId: string; ownerId: string; guildId: string | null; agentId: string | null } {
    if (level === "agent") {
      if (!actor.agentId) throw new ArtifactError("write not allowed", 422);
      return { orgId: actor.orgId, ownerId: actor.agentId, guildId: actor.guildId, agentId: actor.agentId };
    }
    if (level === "guild") {
      if (!actor.guildId) throw new ArtifactError("write not allowed", 422);
      return { orgId: actor.orgId, ownerId: actor.guildId, guildId: actor.guildId, agentId: null };
    }
    return { orgId: actor.orgId, ownerId: actor.orgId, guildId: null, agentId: null };
  }

  private assertBytes(content: string): void {
    if (Buffer.byteLength(content, "utf8") > WRITE_MAX_BYTES) {
      throw new ArtifactError("write exceeds 256 KB", 422);
    }
  }

  private async assertLiveCount(orgId: string, level: ArtifactLevel, ownerId: string): Promise<void> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM artifacts
        WHERE org_id = $1 AND level = $2 AND owner_id = $3 AND deleted_at IS NULL AND kind <> 'object'`,
      [orgId, level, ownerId],
    );
    if (Number(result.rows[0]?.n ?? 0) >= LIVE_ARTIFACTS_MAX) {
      throw new ArtifactError("artifact limit reached", 422);
    }
  }

  private async assertNotEmbedded(orgId: string, displayPath: string): Promise<void> {
    const result = await this.pool.query(
      `SELECT id AS agent_id
         FROM agents
        WHERE org_id = $1 AND task LIKE $2
        LIMIT 5`,
      [orgId, `%![[${displayPath}]]%`],
    );
    if (result.rows.length) {
      const ids = result.rows.map((row) => String((row as { agent_id: string }).agent_id)).join(", ");
      throw new ArtifactError(`note is embedded in task (${ids})`, 409);
    }
  }

  private async loadReserved(
    actor: ArtifactActor,
    agentId: string,
    kind: "memory",
    db: Queryable = this.pool,
  ): Promise<(ArtifactRow & { content_hash: string }) | null> {
    const result = await db.query(
      `SELECT ${ARTIFACT_SELECT}, a.content_hash
         FROM artifacts a
         LEFT JOIN artifact_collections c ON c.id = a.collection_id
        WHERE a.org_id = $1 AND a.agent_id = $2 AND a.kind = $3 AND a.deleted_at IS NULL
        LIMIT 1`,
      [actor.orgId, agentId, kind],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? { ...mapRow(row), content_hash: String(row.content_hash) } : null;
  }

  private async upsertReserved(
    actor: ArtifactActor,
    orgId: string,
    guildId: string,
    agentId: string,
    kind: "memory",
    key: string,
    content: string,
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const now = new Date();
      const result = await client.query(
        `INSERT INTO artifacts (
           id, org_id, level, owner_id, guild_id, agent_id, origin_guild_id, kind,
           collection_id, path, key, content_text, search_text, content_hash, version,
           created_by_type, created_by_id, created_by_name,
           updated_by_type, updated_by_id, updated_by_name, created_at, updated_at
         ) VALUES (
           $1,$2,'agent',$3,$4,$3,$4,$5,NULL,'',$6,$7,$6,$8,1,
           $9,$10,$11,$9,$10,$11,$12,$12
         )
         ON CONFLICT DO NOTHING
         RETURNING ${ARTIFACT_RETURNING}`,
        [
          newId("art"),
          orgId,
          agentId,
          guildId,
          kind,
          key,
          content,
          contentHash(content, null),
          actor.actorType,
          actor.actorId,
          actor.actorName,
          stamp(now),
        ],
      );
      const inserted = result.rows[0] as Record<string, unknown> | undefined;
      if (inserted) {
        const row = mapRow(inserted);
        await recordFileChange(client, actor, {
          orgId: row.org_id,
          artifactId: row.id,
          displayPath: displayPathFor(rowAsDisplay(row)),
          operation: "create",
          version: row.version,
          createdAt: now,
        });
      }
    });
  }

  private async upsertContent(
    actor: ArtifactActor,
    args: {
      level: ArtifactLevel;
      owner: { orgId: string; ownerId: string; guildId: string | null; agentId: string | null };
      kind: "note" | "memory";
      path: string;
      key: string;
      title: string | null;
      contentText: string;
      searchText: string | null;
      expectedVersion?: number;
    },
  ): Promise<ArtifactRow> {
    return withTransaction(this.pool, async (client) => {
      const existing = await client.query(
        `SELECT ${ARTIFACT_SELECT}, a.content_hash
           FROM artifacts a
           LEFT JOIN artifact_collections c ON c.id = a.collection_id
          WHERE a.org_id = $1 AND a.level = $2 AND a.owner_id = $3
            AND a.kind = $4 AND a.collection_id IS NULL
            AND a.path = $5 AND a.key = $6 AND a.deleted_at IS NULL
          LIMIT 1`,
        [args.owner.orgId, args.level, args.owner.ownerId, args.kind, args.path, args.key],
      );
      const live = existing.rows[0] as (Record<string, unknown> & { content_hash?: string }) | undefined;
      if (live) {
        if (args.expectedVersion !== undefined && Number(live.version) !== args.expectedVersion) {
          throw new ArtifactError("version conflict", 409);
        }
        const result = await client.query(
          `UPDATE artifacts
              SET content_text = $2, search_text = $3, title = $4,
                  content_hash = $5, version = version + 1,
                  updated_by_type = $6, updated_by_id = $7, updated_by_name = $8, updated_at = $9
            WHERE id = $1
            RETURNING ${ARTIFACT_RETURNING}`,
          [
            live.id,
            args.contentText,
            args.searchText,
            args.title,
            contentHash(args.contentText, null),
            actor.actorType,
            actor.actorId,
            actor.actorName,
            stamp(new Date()),
          ],
        );
        const row = mapRow(result.rows[0] as Record<string, unknown>);
        await recordFileChange(client, actor, {
          orgId: row.org_id,
          artifactId: row.id,
          displayPath: displayPathFor(rowAsDisplay(row)),
          operation: "update",
          version: row.version,
        });
        return row;
      }
      const now = stamp(new Date());
      try {
        const result = await client.query(
          `INSERT INTO artifacts (
             id, org_id, level, owner_id, guild_id, agent_id, origin_guild_id, kind,
             collection_id, path, key, title, content_text, content_json, search_text,
             content_hash, version,
             created_by_type, created_by_id, created_by_name,
             updated_by_type, updated_by_id, updated_by_name, created_at, updated_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10,$11,$12,NULL,$13,$14,1,
             $15,$16,$17,$15,$16,$17,$18,$18
           )
           RETURNING ${ARTIFACT_RETURNING}`,
          [
            newId("art"),
            args.owner.orgId,
            args.level,
            args.owner.ownerId,
            args.owner.guildId,
            args.owner.agentId,
            actor.guildId,
            args.kind,
            args.path,
            args.key,
            args.title,
            args.contentText,
            args.searchText,
            contentHash(args.contentText, null),
            actor.actorType,
            actor.actorId,
            actor.actorName,
            now,
          ],
        );
        const row = mapRow(result.rows[0] as Record<string, unknown>);
        await recordFileChange(client, actor, {
          orgId: row.org_id,
          artifactId: row.id,
          displayPath: displayPathFor(rowAsDisplay(row)),
          operation: "create",
          version: row.version,
        });
        return row;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ArtifactError("artifact already exists", 409);
        }
        throw error;
      }
    });
  }

  private async loadParsed(
    parsed: Extract<ReturnType<typeof parseDisplayPath>, { kind: "artifact" }>,
    includeDeleted = false,
  ): Promise<(ArtifactRow & { deleted_at?: string | null }) | null> {
    const deleted = includeDeleted ? "" : "AND a.deleted_at IS NULL";
    const result = await this.pool.query(
      `SELECT ${ARTIFACT_SELECT}, a.deleted_at
         FROM artifacts a
         LEFT JOIN artifact_collections c ON c.id = a.collection_id
        WHERE a.org_id = $1 AND a.level = $2 AND a.owner_id = $3
          AND a.path = $4 AND a.key = $5 AND a.collection_id IS NULL
          ${deleted}
        LIMIT 1`,
      [parsed.orgId, parsed.level, parsed.ownerId, parsed.path, parsed.key],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return { ...mapRow(row), deleted_at: (row.deleted_at as string | null) ?? null };
  }

  /**
   * Notes the actor may read, binding only the ids the clause references so
   * that every parameter has a type PostgreSQL can infer.
   */
  private readScope(actor: ArtifactActor, values: unknown[]): string {
    if (actor.operator) {
      values.push(actor.hidden.guildIds, actor.hidden.agentIds);
      return `NOT ((a.level = 'guild' AND a.owner_id = ANY($${values.length - 1}::text[]))
                OR (a.level = 'agent' AND a.owner_id = ANY($${values.length}::text[])))`;
    }
    values.push(actor.agentId ?? "");
    const parts = [`(a.level = 'agent' AND a.agent_id = $${values.length})`];
    if (actor.grants.readGuild) {
      values.push(actor.guildId ?? "");
      parts.push(`(a.level = 'guild' AND a.guild_id = $${values.length})`);
    }
    if (actor.grants.readOrg) {
      parts.push("a.level = 'org'");
    }
    return parts.join(" OR ");
  }

  private levelFilter(level: ArtifactLevel | undefined, values: unknown[]): string {
    if (!level) {
      return "";
    }
    values.push(level);
    return ` AND a.level = $${values.length}`;
  }

  private async searchNotes(
    actor: ArtifactActor,
    query: string,
    level: ArtifactLevel | undefined,
    limit: number,
  ): Promise<ArtifactRow[]> {
    const values: unknown[] = [actor.orgId];
    let sql = `SELECT ${ARTIFACT_SELECT}
         FROM artifacts a
         LEFT JOIN artifact_collections c ON c.id = a.collection_id
        WHERE a.deleted_at IS NULL AND a.kind = 'note' AND a.org_id = $1
          AND (${this.readScope(actor, values)})`;
    sql += this.levelFilter(level, values);
    values.push(query);
    const qIndex = values.length;
    values.push(limit);
    sql += ` AND (
        a.search_document @@ websearch_to_tsquery('simple', $${qIndex})
        OR a.search_text ILIKE '%' || $${qIndex} || '%'
      )
      ORDER BY ts_rank_cd(a.search_document, websearch_to_tsquery('simple', $${qIndex})) DESC, a.updated_at DESC
      LIMIT $${values.length}`;
    const result = await this.pool.query(sql, values);
    return (result.rows as Array<Record<string, unknown>>).map((row) => mapRow(row));
  }

  private async listNotes(actor: ArtifactActor, level: ArtifactLevel | undefined, limit: number): Promise<ArtifactRow[]> {
    const values: unknown[] = [actor.orgId];
    let sql = `SELECT ${ARTIFACT_SELECT}
         FROM artifacts a
         LEFT JOIN artifact_collections c ON c.id = a.collection_id
        WHERE a.deleted_at IS NULL AND a.kind = 'note' AND a.org_id = $1
          AND (${this.readScope(actor, values)})`;
    sql += this.levelFilter(level, values);
    values.push(limit);
    sql += ` ORDER BY a.level, a.key LIMIT $${values.length}`;
    const result = await this.pool.query(sql, values);
    return (result.rows as Array<Record<string, unknown>>).map((row) => mapRow(row));
  }
}

const ARTIFACT_SELECT = `
  a.id, a.org_id, a.level, a.owner_id, a.guild_id, a.agent_id, a.origin_guild_id,
  a.kind, a.collection_id, c.name AS collection_name, a.path, a.key, a.title,
  a.content_text, a.content_json, a.search_text, a.version,
  a.created_by_name, a.updated_by_name, a.created_at, a.updated_at
`;

const ARTIFACT_RETURNING = `
  id, org_id, level, owner_id, guild_id, agent_id, origin_guild_id, kind, collection_id,
  (SELECT name FROM artifact_collections WHERE id = collection_id) AS collection_name,
  path, key, title, content_text, content_json,
  search_text, version, created_by_name, updated_by_name, created_at, updated_at
`;

const COLLECTION_SELECT = `
  artifact_collections.id, artifact_collections.org_id, artifact_collections.guild_id,
  (SELECT g.name FROM guilds g WHERE g.id = artifact_collections.guild_id) AS guild_name,
  artifact_collections.name,
  artifact_collections.purpose, artifact_collections.columns, artifact_collections.next_id,
  artifact_collections.created_by_name, artifact_collections.created_at, artifact_collections.updated_at
`;

/** The owner of a note or file path; a Memory revision belongs to its agent. */
function fileOwner(
  parsed: Extract<ParsedDisplayPath, { kind: "artifact" | "revision" }>,
): { level: ArtifactLevel; ownerId: string } {
  return parsed.kind === "revision" ? { level: "agent", ownerId: parsed.agentId } : parsed;
}

/** Whether a guild- or agent-level owner sits in a private guild the operator actor cannot see. */
function isHiddenOwner(actor: ArtifactActor, level: ArtifactLevel, ownerId: string): boolean {
  if (level === "guild") {
    return actor.hidden.guildIds.includes(ownerId);
  }
  return level === "agent" && actor.hidden.agentIds.includes(ownerId);
}

/** The collection row, or null when there is none or it is the own table of a guild the actor cannot see. */
function visibleCollection(actor: ArtifactActor, row: Record<string, unknown> | undefined): CollectionRow | null {
  if (!row) {
    return null;
  }
  const collection = mapCollection(row);
  return collection.guild_id && actor.hidden.guildIds.includes(collection.guild_id) ? null : collection;
}

/** A grant listing without the guilds and agents the actor cannot see. */
function visibleGrants<T extends { id: string; guild_id?: string }>(actor: ArtifactActor, rows: T[]): T[] {
  return rows.filter((row) => !actor.hidden.guildIds.includes(row.guild_id ?? row.id));
}

function mapCollection(row: Record<string, unknown>): CollectionRow {
  return {
    id: String(row.id),
    org_id: String(row.org_id),
    guild_id: (row.guild_id as string | null) ?? null,
    guild_name: (row.guild_name as string | null) ?? null,
    name: String(row.name),
    purpose: String(row.purpose ?? ""),
    columns: columnsOf(row.columns),
    next_id: Number(row.next_id ?? 1),
    created_by_name: String(row.created_by_name ?? ""),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapReturned(row: Record<string, unknown>, collectionName?: string | null): ArtifactRow {
  const mapped = mapRow(row);
  if (collectionName) {
    mapped.collection_name = collectionName;
  }
  return mapped;
}

function mapRow(row: Record<string, unknown>): ArtifactRow {
  return {
    id: String(row.id),
    org_id: String(row.org_id),
    level: String(row.level) as ArtifactLevel,
    owner_id: String(row.owner_id),
    guild_id: (row.guild_id as string | null) ?? null,
    agent_id: (row.agent_id as string | null) ?? null,
    origin_guild_id: (row.origin_guild_id as string | null) ?? null,
    kind: String(row.kind) as ArtifactKind,
    collection_id: (row.collection_id as string | null) ?? null,
    collection_name: (row.collection_name as string | null) ?? null,
    path: String(row.path ?? ""),
    key: String(row.key),
    title: (row.title as string | null) ?? null,
    content_text: (row.content_text as string | null) ?? null,
    content_json: row.content_json ?? null,
    search_text: (row.search_text as string | null) ?? null,
    version: Number(row.version),
    created_by_name: String(row.created_by_name),
    updated_by_name: String(row.updated_by_name),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function bodyOf(row: ArtifactRow): Record<string, unknown> {
  return row.content_json && typeof row.content_json === "object" && !Array.isArray(row.content_json)
    ? { ...(row.content_json as Record<string, unknown>) }
    : {};
}

function rowAsDisplay(row: ArtifactRow): {
  orgId: string;
  level: ArtifactLevel;
  ownerId: string;
  kind: ArtifactKind;
  collectionName?: string | null;
  path: string;
  key: string;
} {
  return {
    orgId: row.org_id,
    level: row.level,
    ownerId: row.owner_id,
    kind: row.kind,
    collectionName: row.collection_name,
    path: row.path,
    key: row.key,
  };
}

function contentHash(text: string | null, json: unknown): string {
  const body = text ?? JSON.stringify(json ?? {});
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function hashArtifactContent(text: string | null, json: unknown = null): string {
  return contentHash(text, json);
}

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

function uniqueConflictMessage(columns: CollectionColumn[]): string {
  const unique = uniqueColumn(columns);
  return unique ? `another record already holds that ${unique.name}` : "record already exists";
}

function problemColumn(problem: string): string {
  const match = /^column "([^"]+)"/.exec(problem);
  return match?.[1] ?? "";
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
  const column = columnNamed(columns, order.column);
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

function archiveStamp(replacedAt: string, source: string): string {
  const date = new Date(replacedAt);
  const stampName = date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "T");
  const token = source.trim().replaceAll("/", "-").replaceAll(":", "-") || "unknown";
  return `${stampName}-${token}.md`;
}
