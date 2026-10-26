import type pg from "pg";
import { RowMissing, SecretNameTaken } from "./errors.js";
import { isUniqueViolation, type Queryable, stamp, withTransaction } from "./pg.js";

export type SecretGrantRow = {
  guild_id: string | null;
  agent_id: string | null;
  name: string | null;
  in_guild_id: string | null;
};

export type SecretRow = {
  id: string;
  org_id: string;
  name: string;
  description: string;
  org_wide: boolean;
  created_by_user_id: string | null;
  created_by_user_name: string | null;
  created_by_agent_id: string | null;
  created_by_agent_name: string | null;
  created_by_agent_guild_id: string | null;
  created_at: string;
  updated_at: string;
  rotated_at: string;
  grants: SecretGrantRow[];
};

export type SecretCipherRow = SecretRow & {
  ciphertext: Buffer;
  nonce: Buffer;
};

export type AgentSecretRow = {
  id: string;
  name: string;
  description: string;
};

export type DeletedSecretRow = {
  id: string;
};

export type SecretAccessGrant = {
  org_wide: boolean;
  guild_ids: string[];
  agent_ids: string[];
};

export type NewSecret = {
  secretId: string;
  orgId: string;
  name: string;
  description: string;
  access: SecretAccessGrant;
  ciphertext: Buffer;
  nonce: Buffer;
  createdByUserId?: string | null;
  createdByAgentId?: string | null;
};

// A secret's metadata with its grants, each grant naming its target and the guild it sits in.
const SECRET_COLUMNS = `
  s.id, s.org_id, s.name, s.description, s.org_wide,
  s.created_by_user_id, cu.name AS created_by_user_name,
  s.created_by_agent_id, ca.name AS created_by_agent_name, ca.guild_id AS created_by_agent_guild_id,
  s.created_at, s.updated_at, s.rotated_at,
  (SELECT COALESCE(
            jsonb_agg(jsonb_build_object(
                        'guild_id', g.guild_id,
                        'agent_id', g.agent_id,
                        'name', COALESCE(gg.name, ga.name),
                        'in_guild_id', COALESCE(g.guild_id, ga.guild_id))
                      ORDER BY g.agent_id IS NOT NULL, COALESCE(gg.name, ga.name)),
            '[]'::jsonb)
   FROM secret_grants g
   LEFT JOIN guilds gg ON gg.id = g.guild_id
   LEFT JOIN agents ga ON ga.id = g.agent_id
   WHERE g.secret_id = s.id) AS grants`;

const SECRET_FROM = `secrets s
  LEFT JOIN users cu ON cu.id = s.created_by_user_id
  LEFT JOIN agents ca ON ca.id = s.created_by_agent_id`;

async function insertSecretGrants(
  client: pg.PoolClient,
  secretId: string,
  access: SecretAccessGrant,
  now: Date,
): Promise<void> {
  if (access.org_wide) {
    return;
  }
  await client.query(
    `INSERT INTO secret_grants (secret_id, guild_id, agent_id, created_at)
     SELECT $1, guild_id, NULL, $3 FROM unnest($2::text[]) AS guild_id`,
    [secretId, access.guild_ids, stamp(now)],
  );
  await client.query(
    `INSERT INTO secret_grants (secret_id, guild_id, agent_id, created_at)
     SELECT $1, NULL, agent_id, $3 FROM unnest($2::text[]) AS agent_id`,
    [secretId, access.agent_ids, stamp(now)],
  );
}

export async function listSecrets(
  pool: Queryable,
  orgId: string,
  options: { guildId?: string | null; agentId?: string | null } = {},
): Promise<SecretRow[]> {
  const result = await pool.query<SecretRow>(
    `SELECT ${SECRET_COLUMNS}
     FROM ${SECRET_FROM}
     WHERE s.org_id = $1
       AND ($2::text IS NULL OR s.org_wide OR EXISTS (
             SELECT 1 FROM secret_grants g LEFT JOIN agents a ON a.id = g.agent_id
             WHERE g.secret_id = s.id AND (g.guild_id = $2 OR a.guild_id = $2)))
       AND ($3::text IS NULL OR s.org_wide OR EXISTS (
             SELECT 1 FROM secret_grants g
             WHERE g.secret_id = s.id
               AND (g.agent_id = $3 OR g.guild_id = (SELECT guild_id FROM agents WHERE id = $3))))
     ORDER BY s.name`,
    [orgId, options.guildId ?? null, options.agentId ?? null],
  );
  return result.rows;
}

/** The agent's environment: organisation-wide secrets, its guild's grants, and its own. */
export async function listAgentSecrets(
  pool: Queryable,
  options: { orgId: string; guildId: string; agentId: string },
): Promise<AgentSecretRow[]> {
  const result = await pool.query<AgentSecretRow>(
    `SELECT s.id, s.name, s.description
     FROM secrets s
     WHERE s.org_id = $1
       AND (s.org_wide
         OR EXISTS (
           SELECT 1 FROM secret_grants g
           WHERE g.secret_id = s.id
             AND (g.guild_id = $2 OR g.agent_id = $3)))
     ORDER BY s.name`,
    [options.orgId, options.guildId, options.agentId],
  );
  return result.rows;
}

export async function getSecret(
  pool: Queryable,
  secretId: string,
): Promise<SecretCipherRow | null> {
  const result = await pool.query<SecretCipherRow>(
    `SELECT ${SECRET_COLUMNS}, s.ciphertext, s.nonce
     FROM ${SECRET_FROM}
     WHERE s.id = $1`,
    [secretId],
  );
  return result.rows[0] ?? null;
}

export async function getSecretByName(
  pool: Queryable,
  orgId: string,
  name: string,
): Promise<SecretRow | null> {
  const result = await pool.query<SecretRow>(
    `SELECT ${SECRET_COLUMNS}
     FROM ${SECRET_FROM}
     WHERE s.org_id = $1 AND s.name = $2`,
    [orgId, name],
  );
  return result.rows[0] ?? null;
}

export async function insertSecret(
  pool: pg.Pool,
  secret: NewSecret,
  now: Date,
): Promise<SecretRow> {
  try {
    return await withTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO secrets (
           id, org_id, name, description, org_wide, ciphertext, nonce,
           created_by_user_id, created_by_agent_id, created_at, updated_at, rotated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $10)`,
        [
          secret.secretId,
          secret.orgId,
          secret.name,
          secret.description,
          secret.access.org_wide,
          secret.ciphertext,
          secret.nonce,
          secret.createdByUserId ?? null,
          secret.createdByAgentId ?? null,
          stamp(now),
        ],
      );
      await insertSecretGrants(client, secret.secretId, secret.access, now);
      const row =
        (
          await client.query<SecretRow>(
            `SELECT ${SECRET_COLUMNS} FROM ${SECRET_FROM} WHERE s.id = $1`,
            [secret.secretId],
          )
        ).rows[0] ?? null;
      if (!row) {
        throw new RowMissing("secret insert failed");
      }
      return row;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new SecretNameTaken(secret.name);
    }
    throw error;
  }
}

export async function updateSecret(
  pool: Queryable,
  secretId: string,
  changes: {
    name?: string | null;
    description?: string | null;
    ciphertext?: Buffer | null;
    nonce?: Buffer | null;
  },
  now: Date,
): Promise<SecretCipherRow | null> {
  const rotate = changes.ciphertext !== undefined && changes.ciphertext !== null;
  try {
    const result = await pool.query(
      `UPDATE secrets
       SET name = COALESCE($2, name),
           description = COALESCE($3, description),
           ciphertext = COALESCE($4, ciphertext),
           nonce = COALESCE($5, nonce),
           updated_at = $6,
           rotated_at = CASE WHEN $7 THEN $6 ELSE rotated_at END
       WHERE id = $1
       RETURNING id`,
      [
        secretId,
        changes.name ?? null,
        changes.description ?? null,
        rotate ? changes.ciphertext : null,
        rotate ? (changes.nonce ?? null) : null,
        stamp(now),
        rotate,
      ],
    );
    if (!result.rowCount) {
      return null;
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new SecretNameTaken(changes.name ?? "");
    }
    throw error;
  }
  return getSecret(pool, secretId);
}

/** Replaces who gets the secret; organisation-wide drops every grant. */
export async function setSecretAccess(
  pool: pg.Pool,
  secretId: string,
  access: SecretAccessGrant,
  now: Date,
): Promise<SecretCipherRow | null> {
  const found = await withTransaction(pool, async (client) => {
    const updated = await client.query(
      `UPDATE secrets SET org_wide = $2, updated_at = $3 WHERE id = $1 RETURNING id`,
      [secretId, access.org_wide, stamp(now)],
    );
    if (!updated.rowCount) {
      return false;
    }
    await client.query(`DELETE FROM secret_grants WHERE secret_id = $1`, [secretId]);
    await insertSecretGrants(client, secretId, access, now);
    return true;
  });
  return found ? getSecret(pool, secretId) : null;
}

export async function deleteSecret(
  pool: Queryable,
  secretId: string,
): Promise<DeletedSecretRow | null> {
  const result = await pool.query<DeletedSecretRow>(
    `DELETE FROM secrets WHERE id = $1 RETURNING id`,
    [secretId],
  );
  return result.rows[0] ?? null;
}

export async function countSecretsCreatedByAgent(
  pool: Queryable,
  agentId: string,
): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM secrets WHERE created_by_agent_id = $1`,
    [agentId],
  );
  return result.rows[0]?.count ?? 0;
}

/** The organisation's guilds and agents among these ids, each agent with its guild. */
export async function secretGrantTargets(
  pool: Queryable,
  orgId: string,
  guildIds: string[],
  agentIds: string[],
): Promise<{ guildIds: Set<string>; agentGuilds: Map<string, string> }> {
  const guilds = await pool.query<{ id: string }>(
    `SELECT id FROM guilds WHERE org_id = $1 AND id = ANY($2::text[])`,
    [orgId, guildIds],
  );
  const agents = await pool.query<{ id: string; guild_id: string }>(
    `SELECT id, guild_id FROM agents WHERE org_id = $1 AND id = ANY($2::text[])`,
    [orgId, agentIds],
  );
  return {
    guildIds: new Set(guilds.rows.map((row) => row.id)),
    agentGuilds: new Map(agents.rows.map((row) => [row.id, row.guild_id])),
  };
}

/** Every agent of the organisation that this access reaches. */
export async function listAgentIdsReached(
  pool: Queryable,
  orgId: string,
  access: SecretAccessGrant,
): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM agents
     WHERE org_id = $1 AND ($2 OR guild_id = ANY($3::text[]) OR id = ANY($4::text[]))
     ORDER BY id`,
    [orgId, access.org_wide, access.guild_ids, access.agent_ids],
  );
  return result.rows.map((row) => row.id);
}

export async function listActiveRunAgentIdsForSecret(
  pool: Queryable,
  secretId: string,
): Promise<string[]> {
  const result = await pool.query<{ agent_id: string }>(
    `SELECT DISTINCT agent_id
     FROM runs
     WHERE status = 'active'
       AND config_snapshot->'secrets' @> $1::jsonb`,
    [JSON.stringify([{ id: secretId }])],
  );
  return result.rows.map((row) => row.agent_id);
}
