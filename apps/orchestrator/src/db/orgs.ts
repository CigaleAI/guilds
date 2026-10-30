import type { InferSelectModel } from "drizzle-orm";
import type pg from "pg";
import { LastOrgOwner, RowMissing } from "./errors.js";
import { insertDefaultMachine } from "./machines.js";
import { type Queryable, stamp, withTransaction } from "./pg.js";
import { orgMembers, orgModelProviders, orgs, users } from "./schema/index.js";

/** What an extension does with a new organisation, inside the transaction that creates it. */
export type OrgCreatedHook = (
  client: pg.PoolClient,
  org: { id: string },
  now: Date,
) => Promise<void>;

type OrgMember = InferSelectModel<typeof orgMembers>;

export type OrgRow = Omit<InferSelectModel<typeof orgs>, "default_model">;

export type OrgMembershipRow = OrgRow & Pick<OrgMember, "role">;

export type OrgMemberRecordRow = OrgMember;

export type OrgMemberRow = Pick<OrgMember, "user_id" | "role" | "created_at"> &
  Pick<InferSelectModel<typeof users>, "name" | "image" | "email" | "color">;

export type DeletedOrgMemberRow = Pick<OrgMember, "org_id" | "user_id">;

export type OrgModelProviderRow = InferSelectModel<typeof orgModelProviders>;

/** A model provider without its encrypted key. */
export type OrgModelProviderSummaryRow = Omit<OrgModelProviderRow, "ciphertext" | "nonce">;

export type OrgModelProviderListItemRow = OrgModelProviderSummaryRow & {
  own_key: boolean;
};

export type DeletedOrgModelProviderRow = Pick<
  OrgModelProviderSummaryRow,
  "id" | "org_id" | "provider" | "key_hint" | "models"
>;

/** A new organisation and the user who owns it. */
export type NewOrg = {
  orgId: string;
  name: string;
  slug: string;
  userId: string;
};

/** A user joining an organisation, with their role in it. */
export type NewOrgMember = Pick<OrgMember, "org_id" | "user_id" | "role">;

export type NewOrgModelProvider = {
  providerId: string;
  orgId: string;
  provider: string;
  ciphertext: Buffer | null;
  nonce: Buffer | null;
  keyHint: string | null;
  models: string[];
};

/** Locks the organisation's row for the rest of the transaction `db` runs. */
export async function lockOrg(db: Queryable, orgId: string): Promise<void> {
  await db.query(`SELECT 1 FROM orgs WHERE id = $1 FOR UPDATE`, [orgId]);
}

/**
 * Locks the owner rows of the organisations `orgsSql` selects (`$1` binds into it), so owner
 * changes there run one at a time and each sees the owners the one before it left.
 */
export async function lockOwners(
  client: Queryable,
  orgsSql: string,
  values: unknown[],
): Promise<void> {
  await client.query(
    `SELECT 1 FROM org_members WHERE role = 'owner' AND org_id IN (${orgsSql}) FOR UPDATE`,
    values,
  );
}

/** Refuses a change that would take the organisation's only owner, `userId`, away. */
async function refuseLastOwner(
  client: Queryable,
  orgId: string,
  userId: string,
  message: string,
): Promise<void> {
  await lockOwners(client, "SELECT $1::text", [orgId]);
  const result = await client.query<{ user_id: string }>(
    `SELECT user_id FROM org_members WHERE org_id = $1 AND role = 'owner'`,
    [orgId],
  );
  const owners = result.rows.map((row) => row.user_id);
  if (owners.length === 1 && owners[0] === userId) {
    throw new LastOrgOwner(message);
  }
}

export async function listOrgsForUser(
  pool: Queryable,
  userId: string,
): Promise<OrgMembershipRow[]> {
  const result = await pool.query<OrgMembershipRow>(
    `SELECT o.id, o.name, o.slug, o.created_at, o.updated_at, m.role
     FROM org_members m
     JOIN orgs o ON o.id = m.org_id
     WHERE m.user_id = $1
     ORDER BY o.created_at, o.name`,
    [userId],
  );
  return result.rows;
}

export async function listOrgs(pool: Queryable): Promise<OrgRow[]> {
  const result = await pool.query<OrgRow>(
    `SELECT id, name, slug, created_at, updated_at
     FROM orgs
     ORDER BY created_at, name`,
  );
  return result.rows;
}

export async function getMembership(
  pool: Queryable,
  orgId: string,
  userId: string,
): Promise<OrgMembershipRow | null> {
  const result = await pool.query<OrgMembershipRow>(
    `SELECT o.id, o.name, o.slug, o.created_at, o.updated_at, m.role
     FROM org_members m
     JOIN orgs o ON o.id = m.org_id
     WHERE m.org_id = $1 AND m.user_id = $2`,
    [orgId, userId],
  );
  return result.rows[0] ?? null;
}

export async function insertOrg(
  pool: Queryable,
  org: NewOrg,
  now: Date,
  orgCreated?: OrgCreatedHook,
): Promise<OrgRow> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<OrgRow>(
      `INSERT INTO orgs (id, name, slug, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)
       RETURNING id, name, slug, created_at, updated_at`,
      [org.orgId, org.name, org.slug, stamp(now)],
    );
    const row = result.rows[0] ?? null;
    if (!row) {
      throw new RowMissing("org insert failed");
    }
    await insertDefaultMachine(client, org.orgId, now);
    await client.query(
      `INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ($1, $2, 'owner', $3)`,
      [org.orgId, org.userId, stamp(now)],
    );
    await orgCreated?.(client, { id: org.orgId }, now);
    return row;
  });
}

/** An organisation's new name and slug; an absent or null one keeps its value. */
export type OrgRowPatch = { name?: string | null; slug?: string | null };

export async function updateOrg(
  pool: Queryable,
  orgId: string,
  now: Date,
  options: OrgRowPatch,
): Promise<OrgRow | null> {
  const result = await pool.query<OrgRow>(
    `UPDATE orgs
     SET name = COALESCE($2, name),
         slug = COALESCE($3, slug),
         updated_at = $4
     WHERE id = $1
     RETURNING id, name, slug, created_at, updated_at`,
    [orgId, options.name ?? null, options.slug ?? null, stamp(now)],
  );
  return result.rows[0] ?? null;
}

export async function listMembers(pool: Queryable, orgId: string): Promise<OrgMemberRow[]> {
  const result = await pool.query<OrgMemberRow>(
    `SELECT m.user_id, m.role, m.created_at, u.name, u.image, u.email, u.color
     FROM org_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.org_id = $1
     ORDER BY m.created_at, u.name`,
    [orgId],
  );
  return result.rows;
}

export async function insertMember(
  pool: Queryable,
  member: NewOrgMember,
  now: Date,
): Promise<OrgMemberRecordRow | null> {
  const result = await pool.query<OrgMemberRecordRow>(
    `INSERT INTO org_members (org_id, user_id, role, created_at)
     VALUES ($1, $2, $3, $4)
     RETURNING org_id, user_id, role, created_at`,
    [member.org_id, member.user_id, member.role, stamp(now)],
  );
  return result.rows[0] ?? null;
}

/** Changes a member's role; refuses to demote the organisation's only owner. */
export async function updateMemberRole(
  pool: Queryable,
  orgId: string,
  userId: string,
  role: string,
): Promise<OrgMemberRecordRow | null> {
  return withTransaction(pool, async (client) => {
    if (role !== "owner") {
      await refuseLastOwner(client, orgId, userId, "last owner cannot be demoted");
    }
    const result = await client.query<OrgMemberRecordRow>(
      `UPDATE org_members SET role = $3 WHERE org_id = $1 AND user_id = $2
       RETURNING org_id, user_id, role, created_at`,
      [orgId, userId, role],
    );
    return result.rows[0] ?? null;
  });
}

/** Removes a member; refuses to remove the organisation's only owner. */
export async function deleteMember(
  pool: Queryable,
  orgId: string,
  userId: string,
): Promise<DeletedOrgMemberRow | null> {
  return withTransaction(pool, async (client) => {
    await refuseLastOwner(client, orgId, userId, "last owner cannot leave");
    const result = await client.query<DeletedOrgMemberRow>(
      `DELETE FROM org_members WHERE org_id = $1 AND user_id = $2 RETURNING org_id, user_id`,
      [orgId, userId],
    );
    return result.rows[0] ?? null;
  });
}

export async function countOrgGuilds(pool: Queryable, orgId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM guilds WHERE org_id = $1`,
    [orgId],
  );
  return result.rows[0]?.count ?? 0;
}

export async function countOrgAgents(pool: Queryable, orgId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
     FROM agents a
     JOIN guilds p ON p.id = a.guild_id
     WHERE p.org_id = $1`,
    [orgId],
  );
  return result.rows[0]?.count ?? 0;
}

export async function countOrgBrowserAgents(pool: Queryable, orgId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
     FROM agents a
     JOIN guilds p ON p.id = a.guild_id
     WHERE p.org_id = $1
       AND COALESCE((a.config->>'browser')::boolean, FALSE)`,
    [orgId],
  );
  return result.rows[0]?.count ?? 0;
}

export async function countOrgCodingAgents(pool: Queryable, orgId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
     FROM agents a
     JOIN guilds p ON p.id = a.guild_id
     WHERE p.org_id = $1
       AND COALESCE((a.config->>'coding')::boolean, FALSE)`,
    [orgId],
  );
  return result.rows[0]?.count ?? 0;
}

export async function listOrgModelProviders(
  pool: Queryable,
  orgId: string,
): Promise<OrgModelProviderListItemRow[]> {
  const result = await pool.query<OrgModelProviderListItemRow>(
    `SELECT id, org_id, provider, key_hint, models, ciphertext IS NOT NULL AS own_key, created_at, updated_at
     FROM org_model_providers
     WHERE org_id = $1
     ORDER BY provider`,
    [orgId],
  );
  return result.rows;
}

export async function getOrgModelProvider(
  pool: Queryable,
  orgId: string,
  provider: string,
): Promise<OrgModelProviderRow | null> {
  const result = await pool.query<OrgModelProviderRow>(
    `SELECT id, org_id, provider, ciphertext, nonce, key_hint, models, created_at, updated_at
     FROM org_model_providers
     WHERE org_id = $1 AND provider = $2`,
    [orgId, provider],
  );
  return result.rows[0] ?? null;
}

export async function upsertOrgModelProvider(
  pool: Queryable,
  input: NewOrgModelProvider,
  now: Date,
): Promise<OrgModelProviderSummaryRow> {
  const result = await pool.query<OrgModelProviderSummaryRow>(
    `INSERT INTO org_model_providers (
       id, org_id, provider, ciphertext, nonce, key_hint, models, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $8)
     ON CONFLICT (org_id, provider) DO UPDATE SET
       ciphertext = EXCLUDED.ciphertext,
       nonce = EXCLUDED.nonce,
       key_hint = EXCLUDED.key_hint,
       models = EXCLUDED.models,
       updated_at = EXCLUDED.updated_at
     RETURNING id, org_id, provider, key_hint, models, created_at, updated_at`,
    [
      input.providerId,
      input.orgId,
      input.provider,
      input.ciphertext,
      input.nonce,
      input.keyHint,
      input.models,
      stamp(now),
    ],
  );
  const inserted = result.rows[0] ?? null;
  if (!inserted) {
    throw new RowMissing("model provider upsert failed");
  }
  return inserted;
}

export async function deleteOrgModelProvider(
  pool: Queryable,
  orgId: string,
  provider: string,
): Promise<DeletedOrgModelProviderRow | null> {
  const result = await pool.query<DeletedOrgModelProviderRow>(
    `DELETE FROM org_model_providers
     WHERE org_id = $1 AND provider = $2
     RETURNING id, org_id, provider, key_hint, models`,
    [orgId, provider],
  );
  return result.rows[0] ?? null;
}

export async function getOrgDefaultModel(pool: Queryable, orgId: string): Promise<string | null> {
  const result = await pool.query<{ default_model: string | null }>(
    `SELECT default_model FROM orgs WHERE id = $1`,
    [orgId],
  );
  const value = result.rows[0]?.default_model;
  return typeof value === "string" && value ? value : null;
}

export async function setOrgDefaultModel(
  pool: Queryable,
  orgId: string,
  model: string | null,
  now: Date,
): Promise<void> {
  await pool.query(`UPDATE orgs SET default_model = $2, updated_at = $3 WHERE id = $1`, [
    orgId,
    model,
    stamp(now),
  ]);
}

/** Drops an integration's stored values without reading them; true when a row was there. */
export async function deleteInstanceKey(pool: Queryable, integrationId: string): Promise<boolean> {
  const result = await pool.query(`DELETE FROM instance_keys WHERE integration = $1`, [
    integrationId,
  ]);
  return (result.rowCount ?? 0) > 0;
}
