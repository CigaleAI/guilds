import type { Queryable } from "../db/pg.js";
import {
  deleteRecipe,
  getRecipe,
  insertRecipe,
  linkRecipeBuilderSession,
  listRecipes,
  type NewRecipe,
  type RecipeEdit,
  type RecipeRow,
  type RecipeVersion,
  setRecipeStatus,
  writeRecipeBody,
} from "../db/recipes.js";
import { RecipeConflictError, RecipeError } from "./errors.js";

/** A recipe as it enters an organisation's library, where it starts as a private draft. */
export type RecipeDraft = Omit<
  NewRecipe,
  "visibility" | "status" | "sourceGuildId" | "sourceBuilderSessionId"
> &
  Partial<Pick<NewRecipe, "sourceGuildId" | "sourceBuilderSessionId">>;

export function addRecipeDraft(db: Queryable, draft: RecipeDraft, now: Date): Promise<RecipeRow> {
  return insertRecipe(
    db,
    { sourceGuildId: null, sourceBuilderSessionId: null, ...draft, visibility: "private", status: "draft" },
    now,
  );
}

export function orgRecipes(db: Queryable, orgId: string): Promise<RecipeRow[]> {
  return listRecipes(db, orgId);
}

/** The recipe when it belongs to the organisation, otherwise null. */
export async function orgRecipe(db: Queryable, orgId: string, recipeId: string): Promise<RecipeRow | null> {
  const row = await getRecipe(db, recipeId);
  return row && row.org_id === orgId ? row : null;
}

/** Deletes the recipe when it belongs to the organisation; false when it does not. */
export async function deleteOrgRecipe(db: Queryable, orgId: string, recipeId: string): Promise<boolean> {
  return (await orgRecipe(db, orgId, recipeId)) !== null && deleteRecipe(db, recipeId);
}

/** Writes `edit` over the recipe at `version`; a recipe that moved on refuses with its current version. */
export async function writeRecipe(
  db: Queryable,
  version: RecipeVersion,
  edit: RecipeEdit,
  now: Date,
): Promise<RecipeRow> {
  const written = await writeRecipeBody(db, version, edit, now);
  if (written) {
    return written;
  }
  const current = await getRecipe(db, version.id);
  throw new RecipeConflictError("recipe body_version conflict", current?.body_version);
}

export async function linkRecipeToBuilder(
  db: Queryable,
  recipeId: string,
  sessionId: string,
  now: Date,
): Promise<RecipeRow> {
  const linked = await linkRecipeBuilderSession(db, recipeId, sessionId, now);
  if (!linked) {
    throw new RecipeError("recipe not found", 404);
  }
  return linked;
}

/** Marks the recipe ready to apply; the recipe as it was when it is gone. */
export async function markRecipeReady(db: Queryable, recipe: RecipeRow, now: Date): Promise<RecipeRow> {
  return (await setRecipeStatus(db, recipe.id, "ready", now)) ?? recipe;
}
