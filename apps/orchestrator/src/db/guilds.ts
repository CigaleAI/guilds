import type { InferSelectModel } from "drizzle-orm";
import { guildTextChange } from "../guilds/changes.js";
import { DEFAULT_AGENT_MESSAGE_LIMIT, DEFAULT_GUILD_AGENTS } from "../guilds/validation.js";
import type { ChangeActor } from "../lib/change-actor.js";
import { pickColumns } from "./columns.js";
import { recordChangeIfAny } from "./config-changes.js";
import { GuildNameTaken, LastGuildAdmin, RowMissing } from "./errors.js";
import { type Queryable, stamp, withTransaction } from "./pg.js";
import { guildOperators, guildRepositories, guilds, mcpConnections, orgs, users } from "./schema/index.js";
import { deleteGuildUsage } from "./usage.js";

type Guild = InferSelectModel<typeof guilds>;
type McpConnection = InferSelectModel<typeof mcpConnections>;

export type GuildOperatorRow = Pick<InferSelectModel<typeof guildOperators>, "user_id" | "role"> &
  Pick<InferSelectModel<typeof users>, "name">;

const GUILD_KEYS = [
  "id",
  "name",
  "about",
  "description",
  "max_agents",
  "git_author_email",
  "org_id",
  "group_agent_message_limit",
  "visibility",
  "routines_enabled",
  "created_at",
  "updated_at",
] as const;

export type GuildRow = Pick<Guild, (typeof GUILD_KEYS)[number]> & {
  org_slug: InferSelectModel<typeof orgs>["slug"];
  operators: GuildOperatorRow[];
};

export type SoleAdminGuildRow = Pick<Guild, "id" | "name" | "org_id">;

export type GuildRepositoryRow = InferSelectModel<typeof guildRepositories>;

/** A repository with the status and account of the login it is reached through, when it has one. */
export type GuildRepositoryListItemRow = GuildRepositoryRow & {
  connection_status: McpConnection["status"] | null;
  connection_account: McpConnection["account_hint"] | null;
};

export type GuildPatch = {
  name?: string | null | undefined;
  about?: string | null | undefined;
  visibility?: string | null | undefined;
  routinesEnabled?: boolean | null | undefined;
  description?: string | null | undefined;
  maxAgents?: number | null | undefined;
  gitAuthorEmail?: string | null | undefined;
};

export type NewGuild = {
  guildId: string;
  name: string;
  orgId: string;
  about?: string | undefined;
  agentMessageLimit?: number | undefined;
  visibility?: string | undefined;
  creatorUserId?: string | null | undefined;
  description?: string | undefined;
  maxAgents?: number | undefined;
};

export type NewGuildRepository = {
  id: string;
  guildId: string;
  name: string;
  url: string;
  defaultBranch: string;
  connectionId: string | null;
  githubId: number | null;
};

type GuildTextRow = Pick<Guild, "about" | "description">;

// Operators of guild `p`, oldest first: [{ user_id, name, role }].
export function guildOperatorsColumn(alias: string): string {
  return `
  (SELECT COALESCE(
            jsonb_agg(jsonb_build_object('user_id', go.user_id, 'name', u.name, 'role', go.role)
                      ORDER BY go.created_at, u.name),
            '[]'::jsonb)
   FROM guild_operators go JOIN users u ON u.id = go.user_id
   WHERE go.guild_id = p.id) AS ${alias}`;
}

/** Guilds `p` that the user `userRef` names can see: org-visible ones, and private ones they operate. */
export function guildVisibleTo(userRef: string): string {
  return `(p.visibility <> 'private'
           OR EXISTS (SELECT 1 FROM guild_operators go WHERE go.guild_id = p.id AND go.user_id = ${userRef}))`;
}

const GUILD_COLUMNS = `
  ${pickColumns(guilds, GUILD_KEYS, "p")}, o.slug AS org_slug,
  ${guildOperatorsColumn("operators")}`;

/** Writes the fields `options` sets and returns the guild's text after, or null when no guild has `guildId`. */
async function updateGuildRow(
  client: Queryable,
  guildId: string,
  now: Date,
  options: GuildPatch,
): Promise<GuildTextRow | null> {
  const result = await client.query<GuildTextRow>(
    `UPDATE guilds
     SET about = COALESCE($2, about),
         visibility = COALESCE($3, visibility),
         routines_enabled = COALESCE($5, routines_enabled),
         description = COALESCE($6, description),
         max_agents = COALESCE($7, max_agents),
         git_author_email = COALESCE($8, git_author_email),
         name = COALESCE($9, name),
         updated_at = $4
     WHERE id = $1
     RETURNING about, description`,
    [
      guildId,
      options.about ?? null,
      options.visibility ?? null,
      stamp(now),
      options.routinesEnabled ?? null,
      options.description ?? null,
      options.maxAgents ?? null,
      options.gitAuthorEmail ?? null,
      options.name ?? null,
    ],
  );
  return result.rows[0] ?? null;
}

export async function listGuilds(
  pool: Queryable,
  orgId: string | null = null,
): Promise<GuildRow[]> {
  const result = await pool.query<GuildRow>(
    `SELECT ${GUILD_COLUMNS}
     FROM guilds p JOIN orgs o ON o.id = p.org_id
     WHERE $1::text IS NULL OR p.org_id = $1
     ORDER BY p.created_at`,
    [orgId],
  );
  return result.rows;
}

export async function listGuildsForUser(
  pool: Queryable,
  orgId: string,
  userId: string,
): Promise<GuildRow[]> {
  const result = await pool.query<GuildRow>(
    `SELECT ${GUILD_COLUMNS}
     FROM guilds p JOIN orgs o ON o.id = p.org_id
     WHERE p.org_id = $1
       AND ${guildVisibleTo("$2")}
     ORDER BY p.created_at`,
    [orgId, userId],
  );
  return result.rows;
}

/** The organisation's private guilds the user does not operate, with their agents. */
export async function hiddenGuildsFor(
  pool: Queryable,
  orgId: string,
  userId: string,
): Promise<{ guildIds: string[]; agentIds: string[] }> {
  const result = await pool.query<{ id: string; agent_ids: string[] }>(
    `SELECT p.id, COALESCE(array_agg(a.id) FILTER (WHERE a.id IS NOT NULL), '{}') AS agent_ids
     FROM guilds p LEFT JOIN agents a ON a.guild_id = p.id
     WHERE p.org_id = $1 AND NOT ${guildVisibleTo("$2")}
     GROUP BY p.id`,
    [orgId, userId],
  );
  return {
    guildIds: result.rows.map((row) => row.id),
    agentIds: result.rows.flatMap((row) => row.agent_ids),
  };
}

// Members of the guild's organisation who can see it: everyone for an
// org-visible guild, its operators for a private one.
export async function listGuildViewerIds(pool: Queryable, guildId: string): Promise<string[]> {
  const result = await pool.query<{ user_id: string }>(
    `SELECT m.user_id
     FROM guilds p JOIN org_members m ON m.org_id = p.org_id
     WHERE p.id = $1 AND ${guildVisibleTo("m.user_id")}
     ORDER BY m.user_id`,
    [guildId],
  );
  return result.rows.map((row) => row.user_id);
}

export async function insertGuild(pool: Queryable, guild: NewGuild, now: Date): Promise<void> {
  const about = guild.about ?? "";
  const agentMessageLimit = guild.agentMessageLimit ?? DEFAULT_AGENT_MESSAGE_LIMIT;
  const visibility = guild.visibility ?? "org";
  const creatorUserId = guild.creatorUserId ?? null;
  const description = guild.description ?? "";
  const maxAgents = guild.maxAgents ?? DEFAULT_GUILD_AGENTS;
  await withTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO guilds (id, name, org_id, created_at, updated_at, about, description, max_agents, group_agent_message_limit, visibility)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9)`,
      [
        guild.guildId,
        guild.name,
        guild.orgId,
        stamp(now),
        about,
        description,
        maxAgents,
        agentMessageLimit,
        visibility,
      ],
    );
    if (creatorUserId !== null) {
      await client.query(
        `INSERT INTO guild_operators (org_id, guild_id, user_id, role, created_at)
         VALUES ($1, $2, $3, 'admin', $4)`,
        [guild.orgId, guild.guildId, creatorUserId, stamp(now)],
      );
    }
  });
}

export async function deleteGuild(pool: Queryable, guildId: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    await deleteGuildUsage(client, guildId);
    const now = new Date().toISOString();
    await client.query(
      `UPDATE artifacts SET deleted_at = $2, updated_at = $2
        WHERE deleted_at IS NULL
          AND collection_id IN (SELECT id FROM artifact_collections WHERE guild_id = $1 AND deleted_at IS NULL)`,
      [guildId, now],
    );
    await client.query(
      `UPDATE artifact_collections SET deleted_at = $2, updated_at = $2 WHERE guild_id = $1 AND deleted_at IS NULL`,
      [guildId, now],
    );
    await client.query(
      `DELETE FROM artifact_access
        WHERE (subject_type = 'guild' AND subject_id = $1)
           OR (subject_type = 'agent' AND subject_id IN (SELECT id FROM agents WHERE guild_id = $1))
           OR (target_kind = 'collection' AND target_id IN (SELECT id FROM artifact_collections WHERE guild_id = $1))
           OR (target_kind = 'note' AND target_id IN (SELECT id FROM artifacts WHERE guild_id = $1))`,
      [guildId],
    );
    // A secret whose every grant goes with the guild goes with it.
    await client.query(
      `DELETE FROM secrets s
        WHERE NOT s.org_wide
          AND EXISTS (SELECT 1 FROM secret_grants g WHERE g.secret_id = s.id)
          AND NOT EXISTS (
                SELECT 1 FROM secret_grants g LEFT JOIN agents a ON a.id = g.agent_id
                 WHERE g.secret_id = s.id AND COALESCE(g.guild_id, a.guild_id) <> $1)`,
      [guildId],
    );
    await client.query(`DELETE FROM guilds WHERE id = $1`, [guildId]);
  });
}

export async function getGuild(pool: Queryable, guildId: string): Promise<GuildRow | null> {
  const result = await pool.query<GuildRow>(
    `SELECT ${GUILD_COLUMNS}
     FROM guilds p JOIN orgs o ON o.id = p.org_id
     WHERE p.id = $1`,
    [guildId],
  );
  return result.rows[0] ?? null;
}

/** Changes a guild's settings; a change to its about or description is logged against `actor`. */
export async function updateGuild(
  pool: Queryable,
  guildId: string,
  now: Date,
  options: GuildPatch,
  actor: ChangeActor,
): Promise<GuildRow | null> {
  const updated = await withTransaction(pool, async (client) => {
    const before =
      (
        await client.query<GuildTextRow>(
          `SELECT about, description FROM guilds WHERE id = $1 FOR UPDATE`,
          [guildId],
        )
      ).rows[0] ?? null;
    const after = await updateGuildRow(client, guildId, now, options);
    if (before && after) {
      await recordChangeIfAny(client, actor, guildTextChange(guildId, before, after));
    }
    return after;
  });
  return updated ? getGuild(pool, guildId) : null;
}

// Grants `role` to an organisation member, or removes the operator when
// `role` is null. The guild keeps at least one admin, and an operator's
// name stays distinct from its agents' names.
export async function setGuildOperator(
  pool: Queryable,
  guildId: string,
  userId: string,
  role: "admin" | "operator" | null,
  now: Date,
): Promise<GuildRow | null> {
  const changed = await withTransaction(pool, async (client) => {
    const guild =
      (
        await client.query<{ org_id: string }>(
          `SELECT org_id FROM guilds WHERE id = $1 FOR UPDATE`,
          [guildId],
        )
      ).rows[0] ?? null;
    if (!guild) {
      return false;
    }
    if (role === null) {
      await client.query(`DELETE FROM guild_operators WHERE guild_id = $1 AND user_id = $2`, [
        guildId,
        userId,
      ]);
    } else {
      const clash =
        (
          await client.query<{ name: string }>(
            `SELECT u.name FROM users u JOIN agents a ON a.name = u.name AND a.guild_id = $1
             WHERE u.id = $2`,
            [guildId, userId],
          )
        ).rows[0] ?? null;
      if (clash) {
        throw new GuildNameTaken(clash.name, "agent");
      }
      await client.query(
        `INSERT INTO guild_operators (org_id, guild_id, user_id, role, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [guild.org_id, guildId, userId, role, stamp(now)],
      );
    }
    const admins =
      (
        await client.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM guild_operators WHERE guild_id = $1 AND role = 'admin'`,
          [guildId],
        )
      ).rows[0] ?? null;
    if ((admins?.n ?? 0) < 1) {
      throw new LastGuildAdmin();
    }
    return true;
  });
  return changed ? getGuild(pool, guildId) : null;
}

// Guilds in which this user is the only admin, optionally within one organisation.
export async function soleAdminGuilds(
  pool: Queryable,
  userId: string,
  orgId: string | null = null,
): Promise<SoleAdminGuildRow[]> {
  const result = await pool.query<SoleAdminGuildRow>(
    `SELECT p.id, p.name, p.org_id
     FROM guild_operators go
     JOIN guilds p ON p.id = go.guild_id
     WHERE go.user_id = $1
       AND go.role = 'admin'
       AND ($2::text IS NULL OR go.org_id = $2)
       AND NOT EXISTS (
         SELECT 1 FROM guild_operators other
         WHERE other.guild_id = go.guild_id AND other.role = 'admin' AND other.user_id <> go.user_id
       )
     ORDER BY p.name`,
    [userId, orgId],
  );
  return result.rows;
}

export async function countGuildAgents(pool: Queryable, guildId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM agents WHERE guild_id = $1`,
    [guildId],
  );
  return result.rows[0]?.count ?? 0;
}

export async function listGuildRepositories(
  pool: Queryable,
  guildId: string,
): Promise<GuildRepositoryListItemRow[]> {
  const result = await pool.query<GuildRepositoryListItemRow>(
    `SELECT r.id, r.guild_id, r.name, r.url, r.default_branch, r.connection_id, r.github_id, r.created_at, r.updated_at,
            c.status AS connection_status, c.account_hint AS connection_account
       FROM guild_repositories r
       LEFT JOIN mcp_connections c ON c.id = r.connection_id
      WHERE r.guild_id = $1
      ORDER BY r.name`,
    [guildId],
  );
  return result.rows;
}

export async function insertGuildRepository(
  pool: Queryable,
  repository: NewGuildRepository,
  now: Date,
): Promise<GuildRepositoryRow> {
  const result = await pool.query<GuildRepositoryRow>(
    `INSERT INTO guild_repositories (id, guild_id, name, url, default_branch, connection_id, github_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     RETURNING id, guild_id, name, url, default_branch, connection_id, github_id, created_at, updated_at`,
    [
      repository.id,
      repository.guildId,
      repository.name,
      repository.url,
      repository.defaultBranch,
      repository.connectionId,
      repository.githubId,
      stamp(now),
    ],
  );
  const row = result.rows[0] ?? null;
  if (!row) {
    throw new RowMissing("guild repository insert failed");
  }
  return row;
}

export async function deleteGuildRepository(
  pool: Queryable,
  guildId: string,
  repositoryId: string,
): Promise<GuildRepositoryRow | null> {
  const result = await pool.query<GuildRepositoryRow>(
    `DELETE FROM guild_repositories WHERE guild_id = $1 AND id = $2
     RETURNING id, guild_id, name, url, default_branch, connection_id, github_id, created_at, updated_at`,
    [guildId, repositoryId],
  );
  return result.rows[0] ?? null;
}
