import type { InferSelectModel } from "drizzle-orm";
import { tableColumns } from "./columns.js";
import { RowMissing } from "./errors.js";
import { type Queryable, stamp } from "./pg.js";
import { recipeApplies, type ApplyPlan, type ApplyPreview, type ApplyStep, type ApplyWarning } from "./schema/index.js";

export type RecipeApplyRow = InferSelectModel<typeof recipeApplies>;

/** An apply as its skeleton leaves it: the guild it filled, its plan, and its open checklist. */
export type NewRecipeApply = {
  applyId: string;
  orgId: string;
  recipeId: string;
  createdByUserId: string;
  guildId: string;
  createdGuild: boolean;
  recipeBodyVersion: number;
  preview: ApplyPreview;
  plan: ApplyPlan;
  checklist: ApplyStep[];
  warnings: ApplyWarning[];
};

const APPLY_COLUMNS = tableColumns(recipeApplies);

export async function insertRecipeApply(db: Queryable, apply: NewRecipeApply, now: Date): Promise<RecipeApplyRow> {
  const result = await db.query<RecipeApplyRow>(
    `INSERT INTO recipe_applies (
       id, org_id, recipe_id, created_by_user_id, guild_id, created_guild, status,
       recipe_body_version, preview, plan, checklist, warnings, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,'checklist',$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$12)
     RETURNING ${APPLY_COLUMNS}`,
    [
      apply.applyId,
      apply.orgId,
      apply.recipeId,
      apply.createdByUserId,
      apply.guildId,
      apply.createdGuild,
      apply.recipeBodyVersion,
      JSON.stringify(apply.preview),
      JSON.stringify(apply.plan),
      JSON.stringify(apply.checklist),
      JSON.stringify(apply.warnings),
      stamp(now),
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new RowMissing("recipe apply insert failed");
  }
  return row;
}

export async function getRecipeApply(db: Queryable, applyId: string): Promise<RecipeApplyRow | null> {
  const result = await db.query<RecipeApplyRow>(`SELECT ${APPLY_COLUMNS} FROM recipe_applies WHERE id = $1`, [applyId]);
  return result.rows[0] ?? null;
}

/** The guild's most recently updated apply in one of `statuses`. */
export async function latestGuildApply(
  db: Queryable,
  guildId: string,
  statuses: ReadonlyArray<RecipeApplyRow["status"]>,
): Promise<RecipeApplyRow | null> {
  const result = await db.query<RecipeApplyRow>(
    `SELECT ${APPLY_COLUMNS} FROM recipe_applies
      WHERE guild_id = $1 AND status = ANY($2::text[])
      ORDER BY updated_at DESC LIMIT 1`,
    [guildId, statuses],
  );
  return result.rows[0] ?? null;
}

/** An apply's progress: its checklist and the warnings it raised. */
export type ApplyProgress = { checklist: ApplyStep[]; warnings: ApplyWarning[] };

/** Writes the apply's checklist and warnings. */
export async function setApplyChecklist(
  db: Queryable,
  applyId: string,
  progress: ApplyProgress,
  now: Date,
): Promise<RecipeApplyRow | null> {
  const result = await db.query<RecipeApplyRow>(
    `UPDATE recipe_applies SET checklist = $2::jsonb, warnings = $3::jsonb, updated_at = $4 WHERE id = $1
     RETURNING ${APPLY_COLUMNS}`,
    [applyId, JSON.stringify(progress.checklist), JSON.stringify(progress.warnings), stamp(now)],
  );
  return result.rows[0] ?? null;
}

/** Closes the apply as ready, with its final checklist. */
export async function markApplyReady(
  db: Queryable,
  applyId: string,
  checklist: ApplyStep[],
  now: Date,
): Promise<RecipeApplyRow | null> {
  const result = await db.query<RecipeApplyRow>(
    `UPDATE recipe_applies SET status = 'ready', checklist = $2::jsonb, updated_at = $3 WHERE id = $1
     RETURNING ${APPLY_COLUMNS}`,
    [applyId, JSON.stringify(checklist), stamp(now)],
  );
  return result.rows[0] ?? null;
}

export async function markApplyAborted(db: Queryable, applyId: string, now: Date): Promise<RecipeApplyRow | null> {
  const result = await db.query<RecipeApplyRow>(
    `UPDATE recipe_applies SET status = 'aborted', updated_at = $2 WHERE id = $1 RETURNING ${APPLY_COLUMNS}`,
    [applyId, stamp(now)],
  );
  return result.rows[0] ?? null;
}
