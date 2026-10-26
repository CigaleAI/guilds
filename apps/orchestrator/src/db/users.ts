import type pg from "pg";
import { newId } from "../lib/ids.js";
import { SEED_USERS } from "../users/index.js";
import { GuildNameTaken, LastOrgOwner, RowMissing } from "./errors.js";
import { insertDefaultMachine } from "./machines.js";
import { lockOwners, type OrgCreatedHook } from "./orgs.js";
import { type Queryable, stamp, withTransaction } from "./pg.js";

export type UserRow = {
  id: string;
  name: string;
  email: string | null;
  image: string | null;
  timezone: string | null;
  color: string | null;
  created_at: string;
  updated_at: string;
};

export type DeletedUserRow = {
  id: string;
};

export type UserProfilePatch = {
  name?: string | undefined;
  timezone?: string | null | undefined;
  color?: string | null | undefined;
};

export type NewUser = {
  userId: string;
  name: string;
  image?: string | null | undefined;
  email?: string | null | undefined;
};

const USER_COLUMNS = "id, name, email, image, timezone, color, created_at, updated_at";

/** Agents and operators share a guild's tags, so a user may not take an agent's name in a guild they operate. */
async function refuseAgentNameInOperatedGuilds(
  client: Queryable,
  userId: string,
  name: string,
): Promise<void> {
  const clash = await client.query(
    `SELECT 1 FROM guild_operators go JOIN agents a ON a.guild_id = go.guild_id
     WHERE go.user_id = $1 AND a.name = $2
     LIMIT 1`,
    [userId, name],
  );
  if (clash.rowCount) {
    throw new GuildNameTaken(name, "agent");
  }
}

async function writeUserProfile(
  client: Queryable,
  userId: string,
  profile: UserProfilePatch,
  now: Date,
): Promise<UserRow | null> {
  const result = await client.query<UserRow>(
    `UPDATE users SET
       name = CASE WHEN $2 THEN $3 ELSE name END,
       timezone = CASE WHEN $4 THEN $5 ELSE timezone END,
       color = CASE WHEN $6 THEN $7 ELSE color END,
       updated_at = $8
     WHERE id = $1
     RETURNING ${USER_COLUMNS}`,
    [
      userId,
      profile.name !== undefined,
      profile.name ?? null,
      "timezone" in profile,
      profile.timezone ?? null,
      "color" in profile,
      profile.color ?? null,
      stamp(now),
    ],
  );
  return result.rows[0] ?? null;
}

export async function listUsers(pool: Queryable): Promise<UserRow[]> {
  const result = await pool.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users`);
  const seedOrder = new Map<string, number>(SEED_USERS.map((user, index) => [user.id, index]));
  return [...result.rows].sort((a, b) => {
    const left = seedOrder.get(a.id) ?? SEED_USERS.length;
    const right = seedOrder.get(b.id) ?? SEED_USERS.length;
    if (left !== right) {
      return left - right;
    }
    const created = a.created_at.localeCompare(b.created_at);
    if (created !== 0) {
      return created;
    }
    return a.name.localeCompare(b.name);
  });
}

export async function getUser(pool: Queryable, userId: string): Promise<UserRow | null> {
  const result = await pool.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [
    userId,
  ]);
  return result.rows[0] ?? null;
}

export async function getUserByName(pool: Queryable, name: string): Promise<UserRow | null> {
  const result = await pool.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE name = $1`, [
    name,
  ]);
  return result.rows[0] ?? null;
}

export async function getUserByEmail(pool: Queryable, email: string): Promise<UserRow | null> {
  const result = await pool.query<UserRow>(
    `SELECT ${USER_COLUMNS}
     FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  return result.rows[0] ?? null;
}

/** Updates the user's profile; refuses a name an agent holds in a guild the user operates. */
export async function updateUserProfile(
  pool: pg.Pool,
  userId: string,
  profile: UserProfilePatch,
  now: Date,
): Promise<UserRow | null> {
  return withTransaction(pool, async (client) => {
    if (profile.name !== undefined) {
      await refuseAgentNameInOperatedGuilds(client, userId, profile.name);
    }
    return writeUserProfile(client, userId, profile, now);
  });
}

/** Sets or clears the email a user is identified by behind an authenticating proxy. */
export async function setUserEmail(
  pool: Queryable,
  userId: string,
  email: string | null,
  now: Date,
): Promise<UserRow | null> {
  const result = await pool.query<UserRow>(
    `UPDATE users SET email = $2, updated_at = $3
     WHERE id = $1
     RETURNING ${USER_COLUMNS}`,
    [userId, email, stamp(now)],
  );
  return result.rows[0] ?? null;
}

/** A user and their personal organisation; `orgCreated` runs for that organisation. */
export async function insertUser(
  pool: pg.Pool,
  user: NewUser,
  now: Date,
  orgCreated?: OrgCreatedHook,
): Promise<UserRow> {
  const image = user.image ?? null;
  const email = user.email ?? null;
  return withTransaction(pool, async (client) => {
    const result = await client.query<UserRow>(
      `INSERT INTO users (id, name, image, email, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       RETURNING ${USER_COLUMNS}`,
      [user.userId, user.name, image, email, stamp(now)],
    );
    const row = result.rows[0] ?? null;
    if (!row) {
      throw new RowMissing("user insert failed");
    }
    const orgId = newId("org");
    await client.query(
      `INSERT INTO orgs (id, name, slug, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)`,
      [orgId, user.name, user.name, stamp(now)],
    );
    await insertDefaultMachine(client, orgId, now);
    await client.query(
      `INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ($1, $2, 'owner', $3)`,
      [orgId, user.userId, stamp(now)],
    );
    await orgCreated?.(client, { id: orgId }, now);
    return row;
  });
}

/**
 * Deletes the user. Refuses while the user is the only owner of an organisation that keeps
 * other members or guilds; an organisation left with neither is deleted with them.
 */
export async function deleteUser(pool: pg.Pool, userId: string): Promise<DeletedUserRow | null> {
  return withTransaction(pool, async (client) => {
    await lockOwners(
      client,
      "SELECT org_id FROM org_members WHERE user_id = $1 AND role = 'owner'",
      [userId],
    );
    const stranded = await client.query(
      `SELECT 1 FROM org_members m
       WHERE m.user_id = $1 AND m.role = 'owner'
         AND NOT EXISTS (SELECT 1 FROM org_members o WHERE o.org_id = m.org_id AND o.role = 'owner' AND o.user_id <> $1)
         AND (EXISTS (SELECT 1 FROM org_members o WHERE o.org_id = m.org_id AND o.user_id <> $1)
              OR EXISTS (SELECT 1 FROM guilds p WHERE p.org_id = m.org_id))
       LIMIT 1`,
      [userId],
    );
    if (stranded.rows[0]) {
      throw new LastOrgOwner(
        "user is the last owner of an organisation with other members or guilds",
      );
    }
    const result = await client.query<DeletedUserRow>(
      `DELETE FROM users WHERE id = $1 RETURNING id`,
      [userId],
    );
    const row = result.rows[0] ?? null;
    if (row) {
      await client.query(
        `DELETE FROM orgs o
         WHERE NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = o.id)
           AND NOT EXISTS (SELECT 1 FROM guilds p WHERE p.org_id = o.id)`,
      );
    }
    return row;
  });
}
