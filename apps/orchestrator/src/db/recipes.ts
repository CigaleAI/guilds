import type { InferSelectModel } from "drizzle-orm";
import { tableColumns } from "./columns.js";
import { RowMissing } from "./errors.js";
import { type Queryable, stamp } from "./pg.js";
import { recipes } from "./schema/index.js";

export type RecipeRow = InferSelectModel<typeof recipes>;

export type NewRecipe = {
  recipeId: string;
  orgId: string;
  createdByUserId: string | null;
  name: string;
  description: string;
  visibility: RecipeRow["visibility"];
  status: RecipeRow["status"];
  body: unknown;
  sourceKind: RecipeRow["source_kind"];
  sourceGuildId: string | null;
  sourceBuilderSessionId: string | null;
};

/** A recipe's new body and the fields that change with it; a field left out keeps its value. */
export type RecipeEdit = {
  body: unknown;
  name?: string | undefined;
  description?: string | undefined;
  status?: RecipeRow["status"] | undefined;
  sourceBuilderSessionId?: string | null | undefined;
};

/** The version of a recipe a write is based on. */
export type RecipeVersion = Pick<RecipeRow, "id" | "body_version">;

const RECIPE_COLUMNS = tableColumns(recipes);

export async function insertRecipe(pool: Queryable, recipe: NewRecipe, now: Date): Promise<RecipeRow> {
  const result = await pool.query<RecipeRow>(
    `INSERT INTO recipes (
       id, org_id, created_by_user_id, name, description, visibility, status,
       body, body_version, source_kind, source_guild_id, source_builder_session_id,
       created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 1, $9, $10, $11, $12, $12)
     RETURNING ${RECIPE_COLUMNS}`,
    [
      recipe.recipeId,
      recipe.orgId,
      recipe.createdByUserId,
      recipe.name,
      recipe.description,
      recipe.visibility,
      recipe.status,
      JSON.stringify(recipe.body),
      recipe.sourceKind,
      recipe.sourceGuildId,
      recipe.sourceBuilderSessionId,
      stamp(now),
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new RowMissing("recipe insert failed");
  }
  return row;
}

export async function getRecipe(pool: Queryable, recipeId: string): Promise<RecipeRow | null> {
  const result = await pool.query<RecipeRow>(`SELECT ${RECIPE_COLUMNS} FROM recipes WHERE id = $1`, [
    recipeId,
  ]);
  return result.rows[0] ?? null;
}

/** An organisation's hundred most recently updated recipes. */
export async function listRecipes(pool: Queryable, orgId: string): Promise<RecipeRow[]> {
  const result = await pool.query<RecipeRow>(
    `SELECT ${RECIPE_COLUMNS} FROM recipes WHERE org_id = $1 ORDER BY updated_at DESC LIMIT 100`,
    [orgId],
  );
  return result.rows;
}

/**
 * Writes `edit` over the recipe when its body is still at `version`, and bumps the version. The
 * recipe returns to draft unless the edit sets its status. Null when the version moved on.
 */
export async function writeRecipeBody(
  pool: Queryable,
  version: RecipeVersion,
  edit: RecipeEdit,
  now: Date,
): Promise<RecipeRow | null> {
  const result = await pool.query<RecipeRow>(
    `UPDATE recipes
        SET body = $3::jsonb,
            body_version = body_version + 1,
            name = COALESCE($4, name),
            description = COALESCE($5, description),
            status = $6,
            source_builder_session_id = COALESCE($7, source_builder_session_id),
            updated_at = $8
      WHERE id = $1 AND body_version = $2
      RETURNING ${RECIPE_COLUMNS}`,
    [
      version.id,
      version.body_version,
      JSON.stringify(edit.body),
      edit.name ?? null,
      edit.description ?? null,
      edit.status ?? "draft",
      edit.sourceBuilderSessionId ?? null,
      stamp(now),
    ],
  );
  return result.rows[0] ?? null;
}

export async function linkRecipeBuilderSession(
  pool: Queryable,
  recipeId: string,
  sessionId: string,
  now: Date,
): Promise<RecipeRow | null> {
  const result = await pool.query<RecipeRow>(
    `UPDATE recipes SET source_builder_session_id = $2, updated_at = $3
      WHERE id = $1
      RETURNING ${RECIPE_COLUMNS}`,
    [recipeId, sessionId, stamp(now)],
  );
  return result.rows[0] ?? null;
}

export async function setRecipeStatus(
  pool: Queryable,
  recipeId: string,
  status: RecipeRow["status"],
  now: Date,
): Promise<RecipeRow | null> {
  const result = await pool.query<RecipeRow>(
    `UPDATE recipes SET status = $2, updated_at = $3 WHERE id = $1 RETURNING ${RECIPE_COLUMNS}`,
    [recipeId, status, stamp(now)],
  );
  return result.rows[0] ?? null;
}

export async function deleteRecipe(pool: Queryable, recipeId: string): Promise<boolean> {
  const result = await pool.query(`DELETE FROM recipes WHERE id = $1`, [recipeId]);
  return (result.rowCount ?? 0) > 0;
}
