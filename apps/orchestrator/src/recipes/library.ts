import type { ArtifactStore } from "../artifacts/store.js";
import type { ArtifactActor } from "../artifacts/types.js";
import { assignGuildLooks } from "../avatars/looks.js";
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
import type { RecipeFinding, RecipeDocument } from "../db/schema/index.js";
import { newId } from "../lib/ids.js";
import type { RegistryClient } from "../registry/client.js";
import { latestEntries, pickEntry, RegistryError, type RegistryRecipeEntry } from "../registry/index.js";
import type { Schedules } from "../schedules/service.js";
import type { Scripts } from "../scripts/catalog.js";
import { applyAccessEdits, operatorAccessCuts, type AccessCut, type AccessEdit } from "./access-edits.js";
import { validationContext, type RecipeApply } from "./apply.js";
import { captureArtifacts, captureDatabase, captureGuild, type CapturedGuildRow } from "./capture.js";
import { RecipeConflictError, RecipeError } from "./errors.js";
import { parseRecipe } from "./parse.js";
import { applyReview, stampBuilderWrite, unreviewedFields, type ReviewAction } from "./review.js";
import { hasForbiddenSecrets, resetReview } from "./schema.js";
import { blockingErrors, validateRecipe } from "./validate.js";

// An organisation's recipe library: the recipes it holds, how one enters it (an import, a registry
// install, a capture of a live guild, the Builder), and how an operator or the Builder changes,
// validates, publishes and exports one.

/** A recipe as it enters an organisation's library, where it starts as a private draft. */
export type RecipeDraft = Omit<
  NewRecipe,
  "visibility" | "status" | "sourceGuildId" | "sourceBuilderSessionId"
> &
  Partial<Pick<NewRecipe, "sourceGuildId" | "sourceBuilderSessionId">>;

/** The library a recipe is added to, and the user who adds it. */
export type RecipeOwner = { orgId: string; userId: string };

/** A recipe of the registry's index: its name, and its version, the newest when absent. */
export type RegistryRecipeRef = { name: string; version: string | undefined };

/** What a capture reads a live guild through, and the database its draft is added on. */
export type RecipeCaptureDeps = { db: Queryable; artifacts: ArtifactStore; scripts: Scripts; schedules: Schedules };

/**
 * An operator's change to a library recipe: the body version it was read at, the document to
 * store (none keeps the stored one), and a name and description in place of the document's own.
 */
export type RecipeChange = {
  bodyVersion: number;
  document: unknown;
  name: string | undefined;
  description: string | undefined;
};

/** What validating a library recipe in its organisation found, what is left to review, and the access the operator cut. */
export type RecipeValidation = {
  findings: RecipeFinding[];
  errors: RecipeFinding[];
  unreviewed: string[];
  access_cuts: AccessCut[];
  body_version: number;
  status: RecipeRow["status"];
};

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
async function markRecipeReady(db: Queryable, recipe: RecipeRow, now: Date): Promise<RecipeRow> {
  return (await setRecipeStatus(db, recipe.id, "ready", now)) ?? recipe;
}

/** The document as it is imported: every reviewable field unreviewed, and a file as its source. */
function resetImported(recipe: RecipeDocument): RecipeDocument {
  for (const role of recipe.roles) {
    role.task.author = resetReview(role.task.author);
    role.browser.author = resetReview(role.browser.author);
    for (const script of role.scripts) script.author = resetReview(script.author);
    for (const schedule of role.schedules) schedule.author = resetReview(schedule.author);
  }
  for (const note of recipe.notes) note.author = resetReview(note.author);
  for (const connection of recipe.connections) connection.author = resetReview(connection.author);
  for (const card of recipe.external) card.author = resetReview(card.author);
  recipe.meta.source = { kind: "file" };
  return recipe;
}

/** Adds a recipe document to the owner's library as a private draft with every field unreviewed; a document that carries secrets is refused. */
export async function importRecipe(db: Queryable, document: unknown, owner: RecipeOwner): Promise<RecipeRow> {
  const parsed = resetImported(parseRecipe(document));
  if (hasForbiddenSecrets(parsed)) {
    throw new RecipeError("recipe must not contain secrets or ciphertext");
  }
  return addRecipeDraft(
    db,
    {
      recipeId: newId("rcp"),
      orgId: owner.orgId,
      createdByUserId: owner.userId,
      name: parsed.meta.name,
      description: parsed.meta.description,
      body: parsed,
      sourceKind: "file",
    },
    new Date(),
  );
}

/** What a registry offers to import: each recipe's newest entry with every version; empty while the box is offline. */
export type RegistryRecipes = {
  offline: boolean;
  url: string | null;
  recipes: Array<RegistryRecipeEntry & { versions: string[] }>;
};

/** The recipes the box's registry offers, by name; null is the box offline. */
export async function registryRecipes(registry: RegistryClient | null): Promise<RegistryRecipes> {
  if (registry === null) {
    return { offline: true, url: null, recipes: [] };
  }
  const index = await registry.index();
  return {
    offline: false,
    url: registry.baseUrl,
    recipes: latestEntries(index.recipes, (entry) => entry.name),
  };
}

/**
 * Imports the recipe `wanted` names from the registry as `importRecipe` imports a document. One
 * the index lacks is a 404; a file that is not a recipe is refused naming the registry's recipe.
 */
export async function importRegistryRecipe(
  db: Queryable,
  registry: RegistryClient,
  wanted: RegistryRecipeRef,
  owner: RecipeOwner,
): Promise<RecipeRow> {
  const entry = pickEntry(
    (await registry.index()).recipes.filter((item) => item.name === wanted.name),
    wanted.version,
  );
  if (entry === null) {
    throw new RegistryError(
      wanted.version
        ? `the registry has no recipe ${wanted.name}@${wanted.version}`
        : `the registry has no recipe ${wanted.name}`,
      404,
    );
  }
  const file = await registry.recipeFile(entry);
  let document: RecipeDocument;
  try {
    document = parseRecipe(JSON.parse(file.toString("utf8")));
  } catch (error) {
    throw new RegistryError(`recipe ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return importRecipe(db, document, owner);
}

/** Captures the guild as `actor` reads it (`captureGuild`) into its organisation's library, as the actor's private draft. */
export async function captureRecipe(
  deps: RecipeCaptureDeps,
  guild: CapturedGuildRow,
  includeNotes: string[],
  actor: ArtifactActor,
): Promise<RecipeRow> {
  const parsed = await captureGuild(
    {
      db: captureDatabase(deps.db),
      artifacts: captureArtifacts(deps.artifacts),
      scripts: deps.scripts,
      schedules: deps.schedules,
    },
    actor,
    guild,
    includeNotes,
  );
  return addRecipeDraft(
    deps.db,
    {
      recipeId: newId("rcp"),
      orgId: guild.org_id,
      createdByUserId: actor.actorId,
      name: parsed.meta.name,
      description: parsed.meta.description,
      body: parsed,
      sourceKind: "guild",
      sourceGuildId: guild.id,
    },
    new Date(),
  );
}

/** Writes the operator's change over the recipe at the change's body version. */
export async function changeRecipe(db: Queryable, row: RecipeRow, change: RecipeChange): Promise<RecipeRow> {
  const body = change.document === undefined || change.document === null ? row.body : parseRecipe(change.document);
  return writeRecipe(
    db,
    { id: row.id, body_version: change.bodyVersion },
    { body, name: change.name ?? body.meta.name, description: change.description ?? body.meta.description },
    new Date(),
  );
}

/** Parses `document` and writes it over the recipe at `version`, under the name and description it gives itself. */
export async function writeRecipeDocument(db: Queryable, version: RecipeVersion, document: unknown): Promise<RecipeRow> {
  const parsed = parseRecipe(document);
  return writeRecipe(
    db,
    version,
    { body: parsed, name: parsed.meta.name, description: parsed.meta.description },
    new Date(),
  );
}

/**
 * Writes the Builder's `next` over the recipe at `version`: each field that differs from
 * `previous` becomes the Builder's, unreviewed, and a role keeps the look `previous` gave it.
 */
export async function writeBuilderRecipe(
  db: Queryable,
  version: RecipeVersion,
  next: RecipeDocument,
  previous: RecipeDocument,
): Promise<RecipeRow> {
  const stamped = stampBuilderWrite(next, previous);
  assignGuildLooks(stamped.roles, previous.roles);
  return writeRecipe(
    db,
    version,
    { body: stamped, name: stamped.meta.name, description: stamped.meta.description },
    new Date(),
  );
}

/** Applies the operator's access edits to the recipe and writes it, with the access cuts it then holds. */
export async function editRecipeAccess(
  db: Queryable,
  row: RecipeRow,
  edits: AccessEdit[],
): Promise<RecipeRow & { access_cuts: AccessCut[] }> {
  const recipe = row.body;
  const cuts = applyAccessEdits(recipe, edits);
  const written = await writeRecipe(db, row, { body: recipe }, new Date());
  return { ...written, access_cuts: cuts };
}

/** Writes the operator's review of the field at `path`. */
export async function reviewRecipe(db: Queryable, row: RecipeRow, path: string, review: ReviewAction): Promise<RecipeRow> {
  const recipe = row.body;
  applyReview(recipe, path, review);
  return writeRecipe(db, row, { body: recipe }, new Date());
}

/** Validates the recipe in its organisation, naming what the registry offers for a connector the box lacks. */
export async function validateLibraryRecipe(apply: RecipeApply, row: RecipeRow): Promise<RecipeValidation> {
  const recipe = row.body;
  const ctx = await validationContext(apply, row.org_id, recipe);
  ctx.groupLimit = recipe.guild.group_agent_message_limit;
  const findings = validateRecipe(recipe, ctx);
  return {
    findings,
    errors: blockingErrors(findings),
    unreviewed: unreviewedFields(recipe),
    access_cuts: operatorAccessCuts(recipe),
    body_version: row.body_version,
    status: row.status,
  };
}

/** Marks the recipe ready to apply; a recipe with a blocking finding is refused with those findings' messages. */
export async function publishRecipe(apply: RecipeApply, row: RecipeRow): Promise<RecipeRow> {
  const recipe = row.body;
  const ctx = await validationContext(apply, row.org_id);
  ctx.groupLimit = recipe.guild.group_agent_message_limit;
  const errors = blockingErrors(validateRecipe(recipe, ctx));
  if (errors.length) {
    throw new RecipeError(errors.map((item) => item.message).join("; "));
  }
  return markRecipeReady(apply.db, row, new Date());
}

/** The recipe's document to export; a draft, or a document that carries secrets, is refused. */
export function exportRecipe(row: RecipeRow): RecipeDocument {
  if (row.status === "draft") {
    throw new RecipeError("export refused while draft", 409);
  }
  if (hasForbiddenSecrets(row.body)) {
    throw new RecipeError("recipe must not contain secrets", 422);
  }
  return row.body;
}
