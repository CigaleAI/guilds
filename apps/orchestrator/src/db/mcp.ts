import type { InferSelectModel } from "drizzle-orm";
import { newId } from "../lib/ids.js";
import { upsertMcpBinding, type McpConnectionBinding } from "./bindings.js";
import { pickColumns, ownerRefs } from "./columns.js";
import { RowMissing } from "./errors.js";
import { type Queryable, stamp, withTransaction } from "./pg.js";
import { mcpConnections, mcpTools, type ConnectionSettings, type GithubRepositorySelection, type ToolInputSchema } from "./schema/index.js";

/** A connection with the guild, agent and organisation its owner resolves to. */
export type ScopedMcpConnectionRow = InferSelectModel<typeof mcpConnections>;

const MCP_CONNECTION_KEYS = [
  "id",
  "mcp_server_id",
  "owner_scope",
  "owner_id",
  "account_hint",
  "status",
  "ciphertext",
  "nonce",
  "oauth_state",
  "settings",
  "created_at",
  "updated_at",
  "rotated_at",
] as const;

export type McpConnectionRow = Pick<ScopedMcpConnectionRow, (typeof MCP_CONNECTION_KEYS)[number]>;

export type DeletedMcpConnectionRow = Pick<McpConnectionRow, "id">;

export type McpToolRow = InferSelectModel<typeof mcpTools>;

export type NewMcpConnection = {
  connectionId: string;
  bindingId: string;
  serverId: string;
  ownerScope: McpConnectionRow["owner_scope"];
  ownerId: string | null;
  ciphertext: Buffer;
  nonce: Buffer;
  oauthState?: string | null | undefined;
  bind?: boolean | undefined;
  status?: McpConnectionRow["status"] | undefined;
  accountHint?: string | undefined;
  /** The login's settings; a login that replaces one keeps its settings without it. */
  settings?: ConnectionSettings | undefined;
};

/** A login's stored credentials and where its sign-in stands. */
export type McpConnectionLogin = {
  ciphertext: Buffer;
  nonce: Buffer;
  status: McpConnectionRow["status"];
  accountHint: string;
  oauthState: string | null;
};

export type NewMcpTool = {
  remote_name: string;
  namespaced_name: string;
  description: string;
  input_schema: ToolInputSchema;
  read_only_hint?: boolean | null | undefined;
  destructive_hint?: boolean | null | undefined;
};

/** A repository a GitHub login gives a guild. */
export type ConnectionGuildRepository = {
  id: string;
  name: string;
  url: string;
  defaultBranch: string;
  githubId: number | null;
};

const MCP_CONNECTION_COLUMNS = pickColumns(mcpConnections, MCP_CONNECTION_KEYS);

export async function listMcpConnections(
  pool: Queryable,
  options: {
    orgId?: string | null;
    guildId?: string | null;
    agentId?: string | null;
  },
): Promise<ScopedMcpConnectionRow[]> {
  const result = await pool.query<ScopedMcpConnectionRow>(
    `SELECT id, mcp_server_id, owner_scope, owner_id, guild_id, agent_id,
            account_hint, status, ciphertext, nonce, oauth_state, org_id,
            settings, created_at, updated_at, rotated_at
     FROM mcp_connections
     WHERE owner_scope = 'platform'
        OR (owner_scope = 'org' AND owner_id = $1)
        OR (owner_scope = 'guild' AND owner_id = $2)
        OR (owner_scope = 'agent' AND owner_id = $3)
     ORDER BY created_at`,
    [options.orgId ?? null, options.guildId ?? null, options.agentId ?? null],
  );
  return result.rows;
}

export async function getMcpConnection(
  pool: Queryable,
  connectionId: string,
): Promise<McpConnectionRow | null> {
  const result = await pool.query<McpConnectionRow>(
    `SELECT ${MCP_CONNECTION_COLUMNS}
     FROM mcp_connections
     WHERE id = $1`,
    [connectionId],
  );
  return result.rows[0] ?? null;
}

/** Connected GitHub logins on this organisation or on guilds the caller can see. */
export async function listVisibleGithubConnections(
  pool: Queryable,
  serverId: string,
  orgId: string,
  guildIds: string[],
): Promise<McpConnectionRow[]> {
  const result = await pool.query<McpConnectionRow>(
    `SELECT ${MCP_CONNECTION_COLUMNS}
     FROM mcp_connections
     WHERE mcp_server_id = $1
       AND status = 'connected'
       AND (
         (owner_scope = 'org' AND owner_id = $2)
         OR (owner_scope = 'guild' AND owner_id = ANY($3::text[]))
         OR (
           owner_scope = 'agent' AND owner_id IN (
             SELECT a.id FROM agents a WHERE a.guild_id = ANY($3::text[])
           )
         )
       )
     ORDER BY created_at`,
    [serverId, orgId, guildIds],
  );
  return result.rows;
}

export async function getMcpConnectionForOwner(
  pool: Queryable,
  serverId: string,
  ownerScope: string,
  ownerId: string | null,
): Promise<McpConnectionRow | null> {
  const result = await pool.query<McpConnectionRow>(
    `SELECT ${MCP_CONNECTION_COLUMNS}
     FROM mcp_connections
     WHERE mcp_server_id = $1 AND owner_scope = $2
       AND (
         ($2 = 'platform' AND owner_id IS NULL)
         OR owner_id = $3
       )`,
    [serverId, ownerScope, ownerId],
  );
  return result.rows[0] ?? null;
}

export async function connectMcp(
  pool: Queryable,
  connection: NewMcpConnection,
  now: Date,
): Promise<McpConnectionRow> {
  const oauthState = connection.oauthState ?? null;
  const settings = connection.settings === undefined ? null : JSON.stringify(connection.settings);
  const bind = connection.bind ?? true;
  const status = connection.status ?? "pending";
  const accountHint = connection.accountHint ?? "";
  const [orgId, guildId, agentId] = ownerRefs(connection.ownerScope, connection.ownerId);
  return withTransaction(pool, async (client) => {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM mcp_connections
       WHERE mcp_server_id = $1 AND owner_scope = $2
         AND (
           ($2 = 'platform' AND owner_id IS NULL)
           OR owner_id = $3
         )`,
      [connection.serverId, connection.ownerScope, connection.ownerId],
    );
    const existingId = existing.rows[0]?.id;
    let row: McpConnectionRow | null;
    if (existingId === undefined) {
      const inserted = await client.query<McpConnectionRow>(
        `INSERT INTO mcp_connections (
           id, mcp_server_id, owner_scope, owner_id,
           org_id, guild_id, agent_id,
           account_hint, status, ciphertext, nonce, oauth_state,
           created_at, updated_at, rotated_at, settings
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $13, $12, $8, $9, $11, $10, $10, $10,
           COALESCE($14::jsonb, '{}'::jsonb)
         )
         RETURNING ${MCP_CONNECTION_COLUMNS}`,
        [
          connection.connectionId,
          connection.serverId,
          connection.ownerScope,
          connection.ownerId,
          orgId,
          guildId,
          agentId,
          connection.ciphertext,
          connection.nonce,
          stamp(now),
          oauthState,
          status,
          accountHint,
          settings,
        ],
      );
      row = inserted.rows[0] ?? null;
    } else {
      const updated = await client.query<McpConnectionRow>(
        `UPDATE mcp_connections
         SET ciphertext = $2, nonce = $3, account_hint = $7,
             status = $6, oauth_state = $5, settings = COALESCE($8::jsonb, settings),
             updated_at = $4, rotated_at = $4
         WHERE id = $1
         RETURNING ${MCP_CONNECTION_COLUMNS}`,
        [
          existingId,
          connection.ciphertext,
          connection.nonce,
          stamp(now),
          oauthState,
          status,
          accountHint,
          settings,
        ],
      );
      row = updated.rows[0] ?? null;
    }
    if (!row) {
      throw new RowMissing("mcp connection write failed");
    }
    if (bind) {
      await upsertMcpBinding(
        client,
        {
          bindingId: connection.bindingId,
          serverId: connection.serverId,
          ownerScope: connection.ownerScope,
          ownerId: connection.ownerId,
          connectionId: row.id,
        },
        now,
      );
    }
    return row;
  });
}

export async function bindMcpConnection(
  pool: Queryable,
  binding: McpConnectionBinding,
  now: Date,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await upsertMcpBinding(client, binding, now);
  });
}

export async function getMcpConnectionByOauthState(
  pool: Queryable,
  oauthState: string,
): Promise<McpConnectionRow | null> {
  const result = await pool.query<McpConnectionRow>(
    `SELECT ${MCP_CONNECTION_COLUMNS}
     FROM mcp_connections
     WHERE oauth_state = $1`,
    [oauthState],
  );
  return result.rows[0] ?? null;
}

/** The operator's most recent pending GitHub login, when GitHub's authorize hop omitted `state`. */
export async function getPendingGithubConnectionForUser(
  pool: Queryable,
  userId: string,
  serverId: string,
): Promise<McpConnectionRow | null> {
  const result = await pool.query<McpConnectionRow>(
    `SELECT ${MCP_CONNECTION_COLUMNS}
     FROM mcp_connections c
     WHERE c.mcp_server_id = $2
       AND c.status = 'pending'
       AND c.oauth_state IS NOT NULL
       AND (
         (c.owner_scope = 'org' AND EXISTS (
            SELECT 1 FROM org_members m
            WHERE m.org_id = c.owner_id AND m.user_id = $1
         ))
         OR
         (c.owner_scope = 'guild' AND EXISTS (
            SELECT 1 FROM org_members m
            JOIN guilds g ON g.id = c.owner_id
            WHERE m.org_id = g.org_id AND m.user_id = $1
         ))
         OR
         (c.owner_scope = 'agent' AND EXISTS (
            SELECT 1 FROM org_members m
            JOIN agents a ON a.id = c.owner_id
            JOIN guilds g ON g.id = a.guild_id
            WHERE m.org_id = g.org_id AND m.user_id = $1
         ))
       )
     ORDER BY c.updated_at DESC
     LIMIT 1`,
    [userId, serverId],
  );
  return result.rows[0] ?? null;
}

export async function saveMcpConnection(
  pool: Queryable,
  connectionId: string,
  login: McpConnectionLogin,
  now: Date,
): Promise<McpConnectionRow | null> {
  const result = await pool.query<McpConnectionRow>(
    `UPDATE mcp_connections
     SET ciphertext = $2, nonce = $3, status = $4, account_hint = $5,
         oauth_state = $6, updated_at = $7, rotated_at = $7
     WHERE id = $1
     RETURNING ${MCP_CONNECTION_COLUMNS}`,
    [
      connectionId,
      login.ciphertext,
      login.nonce,
      login.status,
      login.accountHint,
      login.oauthState,
      stamp(now),
    ],
  );
  return result.rows[0] ?? null;
}

/**
 * Stores a login's settings. With `connect`, a login that waited for them becomes connected
 * and takes `accountHint` when one is given.
 */
export async function updateMcpConnectionSettings(
  pool: Queryable,
  connectionId: string,
  settings: ConnectionSettings,
  now: Date,
  options: { connect?: boolean; accountHint?: string } = {},
): Promise<McpConnectionRow | null> {
  const result = await pool.query<McpConnectionRow>(
    `UPDATE mcp_connections
     SET settings = $2::jsonb,
         status = CASE WHEN $4 THEN 'connected' ELSE status END,
         account_hint = COALESCE(NULLIF($5, ''), account_hint),
         updated_at = $3
     WHERE id = $1
     RETURNING ${MCP_CONNECTION_COLUMNS}`,
    [
      connectionId,
      JSON.stringify(settings),
      stamp(now),
      options.connect === true,
      options.accountHint ?? "",
    ],
  );
  return result.rows[0] ?? null;
}

/** Replaces the repositories a GitHub login's coding agents clone, in its settings. */
export async function updateMcpConnectionGithubRepositories(
  pool: Queryable,
  connectionId: string,
  repositories: GithubRepositorySelection[],
  now: Date,
): Promise<McpConnectionRow | null> {
  const result = await pool.query<McpConnectionRow>(
    `UPDATE mcp_connections
     SET settings = jsonb_set(settings, '{repositories}', $2::jsonb), updated_at = $3
     WHERE id = $1
     RETURNING ${MCP_CONNECTION_COLUMNS}`,
    [connectionId, JSON.stringify(repositories), stamp(now)],
  );
  return result.rows[0] ?? null;
}

/** Replaces the guild_repositories rows that use this GitHub login, leaving anonymous ones. */
export async function replaceConnectionGuildRepositories(
  pool: Queryable,
  connectionId: string,
  guildId: string,
  repositories: ConnectionGuildRepository[],
  now: Date,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(
      `DELETE FROM guild_repositories
       WHERE guild_id = $2 AND (connection_id = $1 OR name = ANY($3::text[]))`,
      [connectionId, guildId, repositories.map((item) => item.name)],
    );
    for (const repository of repositories) {
      await client.query(
        `INSERT INTO guild_repositories (id, guild_id, name, url, default_branch, connection_id, github_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [
          repository.id,
          guildId,
          repository.name,
          repository.url,
          repository.defaultBranch,
          connectionId,
          repository.githubId,
          stamp(now),
        ],
      );
    }
  });
}

/**
 * Records GitHub's id and current URL for the repository this login lists under `name`: on
 * the guild repositories that use the login and in the login's own selection.
 */
export async function recordGithubRepository(
  pool: Queryable,
  connectionId: string,
  name: string,
  repository: { githubId: number; url: string },
  now: Date,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(
      `UPDATE guild_repositories SET github_id = $3, url = $4, updated_at = $5
       WHERE connection_id = $1 AND name = $2`,
      [connectionId, name, repository.githubId, repository.url, stamp(now)],
    );
    const current = await client.query<{ repositories: GithubRepositorySelection[] | null }>(
      "SELECT settings->'repositories' AS repositories FROM mcp_connections WHERE id = $1 FOR UPDATE",
      [connectionId],
    );
    const selected = current.rows[0]?.repositories ?? [];
    if (!selected.some((item) => item.name === name)) {
      return;
    }
    const next = selected.map((item) =>
      item.name === name ? { ...item, github_id: repository.githubId, url: repository.url } : item,
    );
    await client.query(
      "UPDATE mcp_connections SET settings = jsonb_set(settings, '{repositories}', $2::jsonb) WHERE id = $1",
      [connectionId, JSON.stringify(next)],
    );
  });
}

export async function deleteMcpConnection(
  pool: Queryable,
  connectionId: string,
): Promise<DeletedMcpConnectionRow | null> {
  const result = await pool.query<DeletedMcpConnectionRow>(
    `DELETE FROM mcp_connections WHERE id = $1 RETURNING id`,
    [connectionId],
  );
  return result.rows[0] ?? null;
}

/** How many logins to a server are not disconnected, at every scope. */
export async function countServerConnections(pool: Queryable, serverId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM mcp_connections WHERE mcp_server_id = $1 AND status <> 'disconnected'`,
    [serverId],
  );
  return result.rows[0]?.count ?? 0;
}

/** Marks every login to a server disconnected, at every scope; returns how many it changed. */
export async function disconnectServerConnections(
  pool: Queryable,
  serverId: string,
  now = new Date(),
): Promise<number> {
  const result = await pool.query(
    `UPDATE mcp_connections
        SET status = 'disconnected', oauth_state = NULL, updated_at = $2
      WHERE mcp_server_id = $1 AND status <> 'disconnected'`,
    [serverId, now.toISOString()],
  );
  return result.rowCount ?? 0;
}

/** Whether a server the organisation can see lists a tool under this namespaced name. */
export async function isListedMcpTool(
  pool: Queryable,
  namespacedName: string,
  orgId: string | null,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM mcp_tools t JOIN connectors s ON s.id = t.mcp_server_id
     WHERE t.namespaced_name = $1 AND (s.owner_org_id IS NULL OR s.owner_org_id = $2)
     LIMIT 1`,
    [namespacedName, orgId],
  );
  return Boolean(result.rowCount);
}

export async function listMcpTools(pool: Queryable, connectionId: string): Promise<McpToolRow[]> {
  const result = await pool.query<McpToolRow>(
    `SELECT id, connection_id, mcp_server_id, remote_name, namespaced_name,
            description, input_schema, listed_at, read_only_hint, destructive_hint
     FROM mcp_tools
     WHERE connection_id = $1
     ORDER BY namespaced_name`,
    [connectionId],
  );
  return result.rows;
}

export async function replaceMcpTools(
  pool: Queryable,
  connectionId: string,
  tools: NewMcpTool[],
  now: Date,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    const connection = await client.query<{ id: string; mcp_server_id: string }>(
      `SELECT id, mcp_server_id FROM mcp_connections WHERE id = $1`,
      [connectionId],
    );
    const conn = connection.rows[0] ?? null;
    if (!conn) {
      throw new RowMissing("mcp connection not found");
    }
    await client.query(`DELETE FROM mcp_tools WHERE connection_id = $1`, [connectionId]);
    for (const tool of tools) {
      await client.query(
        `INSERT INTO mcp_tools (
           id, connection_id, mcp_server_id, remote_name, namespaced_name,
           description, input_schema, listed_at, read_only_hint, destructive_hint
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
        [
          newId("tool"),
          connectionId,
          conn.mcp_server_id,
          tool.remote_name,
          tool.namespaced_name,
          tool.description,
          JSON.stringify(tool.input_schema),
          stamp(now),
          tool.read_only_hint ?? null,
          tool.destructive_hint ?? null,
        ],
      );
    }
  });
}

/** Marks every listing of a server's tools stale, so each login lists them again on its next use. */
export async function expireMcpTools(pool: Queryable, serverId: string): Promise<void> {
  await pool.query(`UPDATE mcp_tools SET listed_at = 'epoch' WHERE mcp_server_id = $1`, [serverId]);
}
