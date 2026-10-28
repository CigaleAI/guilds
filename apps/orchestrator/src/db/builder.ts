import type { InferSelectModel } from "drizzle-orm";
import type pg from "pg";
import { patchAssignments, tableColumns } from "./columns.js";
import { CONVERSATION_SESSION_COLUMNS, type ConversationSessionPatch } from "./conversations.js";
import { RowMissing } from "./errors.js";
import { type Queryable, stamp } from "./pg.js";
import type { RecipeRow } from "./recipes.js";
import { builderSessions } from "./schema/index.js";

export type BuilderSessionRow = InferSelectModel<typeof builderSessions>;

/** A Builder session with the name, status and version of the recipe it builds. */
export type BuilderSessionListRow = BuilderSessionRow & {
  recipe_name: RecipeRow["name"] | null;
  recipe_status: RecipeRow["status"] | null;
  recipe_body_version: RecipeRow["body_version"] | null;
};

export type NewBuilderSession = {
  sessionId: string;
  orgId: string;
  createdByUserId: string | null;
  createdByName: string;
  recipeId: string;
  configSnapshot: BuilderSessionRow["config_snapshot"];
};

const SESSION_COLUMNS = tableColumns(builderSessions);

export async function insertBuilderSession(
  pool: Queryable,
  session: NewBuilderSession,
  now: Date,
): Promise<BuilderSessionRow> {
  const result = await pool.query<BuilderSessionRow>(
    `INSERT INTO builder_sessions (
       id, org_id, created_by_user_id, created_by_name, recipe_id, config_snapshot,
       status, blocked_reason, generation_state, generation_number, errors, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'active', NULL, 'idle', 0, '[]'::jsonb, $7, $7)
     RETURNING ${SESSION_COLUMNS}`,
    [
      session.sessionId,
      session.orgId,
      session.createdByUserId,
      session.createdByName,
      session.recipeId,
      JSON.stringify(session.configSnapshot),
      stamp(now),
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new RowMissing("builder session insert failed");
  }
  return row;
}

export async function getBuilderSession(pool: Queryable, sessionId: string): Promise<BuilderSessionRow | null> {
  const result = await pool.query<BuilderSessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM builder_sessions WHERE id = $1`,
    [sessionId],
  );
  return result.rows[0] ?? null;
}

/** The user's fifty most recently updated sessions in the organisation. */
export async function listBuilderSessions(
  pool: Queryable,
  orgId: string,
  userId: string,
): Promise<BuilderSessionListRow[]> {
  const result = await pool.query<BuilderSessionListRow>(
    `SELECT ${tableColumns(builderSessions, "s")},
            r.name AS recipe_name, r.status AS recipe_status, r.body_version AS recipe_body_version
       FROM builder_sessions s
       LEFT JOIN recipes r ON r.id = s.recipe_id
      WHERE s.org_id = $1 AND s.created_by_user_id = $2
      ORDER BY s.updated_at DESC
      LIMIT 50`,
    [orgId, userId],
  );
  return result.rows;
}

/** The session, locked for the rest of the transaction `client` is in. */
export async function lockBuilderSession(
  client: pg.PoolClient,
  sessionId: string,
): Promise<BuilderSessionRow | null> {
  const result = await client.query<BuilderSessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM builder_sessions WHERE id = $1 FOR UPDATE`,
    [sessionId],
  );
  return result.rows[0] ?? null;
}

export async function updateBuilderSession(
  pool: Queryable,
  sessionId: string,
  patch: ConversationSessionPatch,
  now: Date,
): Promise<BuilderSessionRow | null> {
  const { sets, values } = patchAssignments(patch, CONVERSATION_SESSION_COLUMNS, 3);
  const result = await pool.query<BuilderSessionRow>(
    `UPDATE builder_sessions SET ${["updated_at = $2", ...sets].join(", ")}
      WHERE id = $1
      RETURNING ${SESSION_COLUMNS}`,
    [sessionId, stamp(now), ...values],
  );
  return result.rows[0] ?? null;
}

/** The sessions a generation was running or cancelling on when the process stopped. */
export async function listGeneratingBuilderSessions(pool: Queryable): Promise<BuilderSessionRow[]> {
  const result = await pool.query<BuilderSessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM builder_sessions WHERE generation_state IN ('generating', 'cancelling')`,
  );
  return result.rows;
}
