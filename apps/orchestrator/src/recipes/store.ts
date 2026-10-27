import type pg from "pg";
import { jsonObj } from "../db/json.js";
import { firstRow, stamp, withTransaction, type Queryable } from "../db/pg.js";
import { RecipeConflictError, RecipeError } from "./errors.js";
import { parseRecipe, type RecipeDocument } from "./schema.js";

function mapRecipe(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    org_id: row.org_id,
    created_by_user_id: row.created_by_user_id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    status: row.status,
    body: jsonObj(row.body),
    body_version: Number(row.body_version),
    source_kind: row.source_kind,
    source_guild_id: row.source_guild_id,
    source_builder_session_id: row.source_builder_session_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class RecipeStore {
  constructor(public pool: Queryable) {}

  async insert(row: Record<string, unknown>, client?: pg.PoolClient): Promise<Record<string, unknown>> {
    const db = client ?? this.pool;
    const result = await db.query(
      `INSERT INTO recipes (
         id, org_id, created_by_user_id, name, description, visibility, status,
         body, body_version, source_kind, source_guild_id, source_builder_session_id,
         created_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$13
       ) RETURNING *`,
      [
        row.id,
        row.org_id,
        row.created_by_user_id ?? null,
        row.name,
        row.description ?? "",
        row.visibility ?? "private",
        row.status ?? "draft",
        JSON.stringify(row.body ?? {}),
        row.body_version ?? 1,
        row.source_kind,
        row.source_guild_id ?? null,
        row.source_builder_session_id ?? null,
        stamp(row.now as Date),
      ],
    );
    const inserted = firstRow(result);
    if (!inserted) {
      throw new RecipeError("recipe insert failed", 500);
    }
    return mapRecipe(inserted);
  }

  async get(recipeId: string, client?: pg.PoolClient): Promise<Record<string, unknown> | null> {
    const db = client ?? this.pool;
    const result = await db.query(`SELECT * FROM recipes WHERE id = $1`, [recipeId]);
    const row = firstRow(result);
    return row ? mapRecipe(row) : null;
  }

  async list(orgId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT * FROM recipes WHERE org_id = $1 ORDER BY updated_at DESC LIMIT 100`,
      [orgId],
    );
    return (result.rows as Array<Record<string, unknown>>).map(mapRecipe);
  }

  async writeBody(
    recipeId: string,
    expectedVersion: number,
    body: RecipeDocument,
    patch: { name?: string; description?: string; status?: string; source_builder_session_id?: string | null },
    now: Date,
    client?: pg.PoolClient,
  ): Promise<Record<string, unknown>> {
    // Body writes return the recipe to draft unless the caller sets status.
    // Approve/publish uses setStatus so apply cannot run mid-construction.
    const db = client ?? this.pool;
    const result = await db.query(
      `UPDATE recipes
          SET body = $3::jsonb,
              body_version = body_version + 1,
              name = COALESCE($4, name),
              description = COALESCE($5, description),
              status = $6,
              source_builder_session_id = COALESCE($7, source_builder_session_id),
              updated_at = $8
        WHERE id = $1 AND body_version = $2
        RETURNING *`,
      [
        recipeId,
        expectedVersion,
        JSON.stringify(body),
        patch.name ?? null,
        patch.description ?? null,
        patch.status ?? "draft",
        patch.source_builder_session_id ?? null,
        stamp(now),
      ],
    );
    const row = firstRow(result);
    if (!row) {
      const current = await this.get(recipeId, client);
      throw new RecipeConflictError(
        "recipe body_version conflict",
        current ? Number(current.body_version) : undefined,
      );
    }
    return mapRecipe(row);
  }

  async linkBuilderSession(
    recipeId: string,
    sessionId: string,
    now: Date,
    client?: pg.PoolClient,
  ): Promise<Record<string, unknown>> {
    const db = client ?? this.pool;
    const result = await db.query(
      `UPDATE recipes
          SET source_builder_session_id = $2,
              updated_at = $3
        WHERE id = $1
        RETURNING *`,
      [recipeId, sessionId, stamp(now)],
    );
    const row = firstRow(result);
    if (!row) {
      throw new RecipeError("recipe not found", 404);
    }
    return mapRecipe(row);
  }

  async setStatus(recipeId: string, status: string, now: Date): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `UPDATE recipes SET status = $2, updated_at = $3 WHERE id = $1 RETURNING *`,
      [recipeId, status, stamp(now)],
    );
    const row = firstRow(result);
    return row ? mapRecipe(row) : null;
  }

  async delete(recipeId: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM recipes WHERE id = $1 RETURNING id`, [recipeId]);
    return Boolean(firstRow(result));
  }

  parsed(row: Record<string, unknown>): RecipeDocument {
    return parseRecipe(row.body);
  }

  async withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, fn);
  }
}
