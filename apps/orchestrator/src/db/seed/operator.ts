import type pg from "pg";
import { SEED_ORG_FOUNDERS, SEED_ORG_ID, SEED_ORG_NAME, SEED_ORG_SLUG } from "../../organisations/index.js";
import { SEED_USERS } from "../../users/index.js";
import { insertDefaultMachine } from "../machines.js";
import { isUniqueViolation, withTransaction } from "../pg.js";

/**
 * A fresh box's first user and the organisation they own. Seeded only while the box has no user
 * at all, so a box an extension has populated, or one whose operator has renamed themselves, is
 * left as it is.
 */
export async function seedOperator(pool: pg.Pool, now = new Date()): Promise<void> {
  const existing = await pool.query("SELECT 1 FROM users LIMIT 1");
  if (existing.rowCount) {
    return;
  }
  const timestamp = now.toISOString();
  for (const user of SEED_USERS) {
    await pool.query(
      `INSERT INTO users (id, name, email, image, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (id) DO NOTHING`,
      [user.id, user.name, user.email, user.image, timestamp],
    );
  }
  await withTransaction(pool, async (client) => {
    const created = await client.query(
      `INSERT INTO orgs (id, name, slug, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (id) DO NOTHING`,
      [SEED_ORG_ID, SEED_ORG_NAME, SEED_ORG_SLUG, timestamp],
    );
    if (created.rowCount) {
      await insertDefaultMachine(client, SEED_ORG_ID, now);
    }
  });
  for (const userId of SEED_ORG_FOUNDERS) {
    await pool.query(
      `INSERT INTO org_members (org_id, user_id, role, created_at)
       VALUES ($1, $2, 'owner', $3)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [SEED_ORG_ID, userId, timestamp],
    );
  }
}

/**
 * Gives the box's first user the address an authenticating proxy sends for them, which is how
 * `trusted-header` identifies them. A box without that user is left as it is.
 */
export async function setOperatorEmail(pool: pg.Pool, email: string, now = new Date()): Promise<void> {
  try {
    await pool.query(
      `UPDATE users SET email = $2, updated_at = $3
       WHERE id = $1 AND email IS DISTINCT FROM $2`,
      [SEED_USERS[0].id, email, now.toISOString()],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new Error("OPERATOR_EMAIL is another user's email", { cause: error });
    }
    throw error;
  }
}
