import { Type } from "@sinclair/typebox";
import { parseAccessEdits } from "../recipes/access-edits.js";
import {
  captureRecipe,
  changeRecipe,
  deleteOrgRecipe,
  editRecipeAccess,
  exportRecipe,
  importRecipe,
  importRegistryRecipe,
  orgRecipe,
  orgRecipes,
  publishRecipe,
  registryRecipes,
  reviewRecipe,
  validateLibraryRecipe,
} from "../recipes/library.js";
import { requireVisibleGuild } from "../guilds/access.js";
import { loadOperatorActor } from "../artifacts/actors.js";
import { userActor } from "../lib/change-actor.js";
import { parseReviewAction, ReviewSchema } from "../recipes/review.js";
import { ApplyChoicesSchema } from "../recipes/apply.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { registryOf } from "./admin-registry-routes.js";
import { HttpError } from "./errors.js";
import { currentOrg, currentUser } from "./identity.js";
import { GuildParams } from "./params.js";
import type { OrgMembershipRow } from "../db/orgs.js";
import { confirmStep, skipStep, verifyStep, writeApplyOverlays } from "../recipes/checklist.js";
import { abortApply, activateApply, guildApplyState, orgApply } from "../recipes/lifecycle.js";
import { previewApply } from "../recipes/plan.js";
import { createSkeleton } from "../recipes/skeleton.js";

function applyOf(deps: AppDeps) {
  if (!deps.apply) {
    throw new HttpError(422, "recipe apply is not available");
  }
  return deps.apply;
}

async function ownedRecipe(deps: AppDeps, recipeId: string, org: OrgMembershipRow) {
  const row = await orgRecipe(deps.db, org.id, recipeId);
  if (!row) {
    throw new HttpError(404, "recipe not found");
  }
  return row;
}

async function ownedApply(deps: AppDeps, applyId: string, org: OrgMembershipRow) {
  const row = await orgApply(applyOf(deps), org.id, applyId);
  if (!row) {
    throw new HttpError(404, "apply not found");
  }
  return row;
}

/** A recipe document to import, alone or as `recipe`; the recipe's own rules check it. */
const RecipeImportSchema = Type.Record(Type.String(), Type.Unknown());

/** A registry recipe to import: its name, and a version (the newest when left out). */
const RegistryRecipeSchema = Type.Object({
  name: Type.Optional(Type.String()),
  version: Type.Optional(Type.String()),
});

/** A guild captured as a recipe, with the notes it carries by display path or file name. */
const CaptureSchema = Type.Object({ include_notes: Type.Optional(Type.Array(Type.String())) });

/** The path of one recipe. */
const RecipeParams = Type.Object({ recipe_id: Type.String() });

/** A change to a recipe: its document over the version read, its name, its description. */
const RecipeChangeSchema = Type.Object({
  expected_body_version: Type.Optional(Type.Number()),
  recipe: Type.Optional(Type.Unknown()),
  name: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
});

/** The access edits to apply to a recipe, which the recipe's own rules check. */
const AccessEditsSchema = Type.Object({ edits: Type.Unknown() });

/** The path of one apply. */
const ApplyParams = Type.Object({ apply_id: Type.String() });

/** The login an apply's overlays are written for: the connector and the connection. */
const OverlaysSchema = Type.Object({
  server: Type.Optional(Type.String()),
  connection_id: Type.Optional(Type.String()),
});

/** The path of one step of an apply's checklist. */
const StepParams = Type.Object({ apply_id: Type.String(), step_id: Type.String() });

/** How a step is closed: done by hand, done later, or skipped. */
const StepConfirmSchema = Type.Object({
  skip: Type.Optional(Type.Boolean()),
  later: Type.Optional(Type.Boolean()),
});

export async function registerRecipeRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const { db } = deps;

  app.get("/api/recipes", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    return orgRecipes(db, org.id);
  });

  app.post(
    "/api/recipes/import",
    { schema: { body: RecipeImportSchema } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const body = request.body;
      const row = await importRecipe(db, body.recipe ?? body, { orgId: org.id, userId: user.id });
      reply.code(201);
      return row;
    },
  );

  app.get("/api/recipes/registry", async (request) => {
    await currentUser(db, request, deps);
    return registryRecipes(registryOf(deps));
  });

  app.post(
    "/api/recipes/registry/import",
    { schema: { body: RegistryRecipeSchema } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const wanted = { name: request.body.name ?? "", version: request.body.version || undefined };
      const owner = { orgId: org.id, userId: user.id };
      const row = await importRegistryRecipe(db, registryOf(deps), wanted, owner);
      reply.code(201);
      return row;
    },
  );

  app.post(
    "/api/guilds/:guild_id/recipes",
    { schema: { params: GuildParams, body: CaptureSchema } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      await currentOrg(db, request, user);
      if (!deps.artifacts) {
        throw new HttpError(422, "recipes are not available");
      }
      const guild = await requireVisibleGuild(db, request.params.guild_id, user.id);
      const actor = await loadOperatorActor(db, user, { orgId: guild.org_id, guildId: guild.id });
      const row = await captureRecipe(
        { db, artifacts: deps.artifacts, scripts: deps.scripts, schedules: deps.schedules },
        guild,
        request.body.include_notes ?? [],
        actor,
      );
      reply.code(201);
      return row;
    },
  );

  app.get("/api/recipes/:recipe_id", { schema: { params: RecipeParams } }, async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    return ownedRecipe(deps, request.params.recipe_id, org);
  });

  app.put(
    "/api/recipes/:recipe_id",
    { schema: { params: RecipeParams, body: RecipeChangeSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const body = request.body;
      const row = await ownedRecipe(deps, request.params.recipe_id, org);
      return await changeRecipe(db, row, {
        bodyVersion: body.expected_body_version ?? row.body_version,
        document: body.recipe,
        name: body.name,
        description: body.description,
      });
    },
  );

  app.post(
    "/api/recipes/:recipe_id/access",
    { schema: { params: RecipeParams, body: AccessEditsSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const row = await ownedRecipe(deps, request.params.recipe_id, org);
      return await editRecipeAccess(db, row, parseAccessEdits(request.body));
    },
  );

  app.post(
    "/api/recipes/:recipe_id/review",
    { schema: { params: RecipeParams, body: ReviewSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const body = request.body;
      const row = await ownedRecipe(deps, request.params.recipe_id, org);
      return await reviewRecipe(db, row, body.path ?? "", parseReviewAction(body));
    },
  );

  app.delete("/api/recipes/:recipe_id", { schema: { params: RecipeParams } }, async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    if (!(await deleteOrgRecipe(db, org.id, request.params.recipe_id))) {
      throw new HttpError(404, "recipe not found");
    }
    return { ok: true };
  });

  app.post(
    "/api/recipes/:recipe_id/validate",
    { schema: { params: RecipeParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const row = await ownedRecipe(deps, request.params.recipe_id, org);
      return await validateLibraryRecipe(applyOf(deps), row);
    },
  );

  app.post(
    "/api/recipes/:recipe_id/publish",
    { schema: { params: RecipeParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const row = await ownedRecipe(deps, request.params.recipe_id, org);
      return await publishRecipe(applyOf(deps), row);
    },
  );

  app.get(
    "/api/recipes/:recipe_id/export",
    { schema: { params: RecipeParams } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const recipe = exportRecipe(await ownedRecipe(deps, request.params.recipe_id, org));
      reply.header("content-type", "application/json");
      return recipe;
    },
  );

  app.post(
    "/api/recipes/:recipe_id/preview",
    { schema: { params: RecipeParams, body: ApplyChoicesSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const row = await ownedRecipe(deps, request.params.recipe_id, org);
      return await previewApply(applyOf(deps), { org, recipeRow: row, user }, request.body);
    },
  );

  app.post(
    "/api/recipes/:recipe_id/apply",
    { schema: { params: RecipeParams, body: ApplyChoicesSchema } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const row = await ownedRecipe(deps, request.params.recipe_id, org);
      const scope = { org, user, recipeRow: row };
      const created = await createSkeleton(applyOf(deps), scope, request.body);
      reply.code(201);
      return created;
    },
  );

  app.get("/api/applies/:apply_id", { schema: { params: ApplyParams } }, async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    return ownedApply(deps, request.params.apply_id, org);
  });

  app.get("/api/guilds/:guild_id/apply", { schema: { params: GuildParams } }, async (request) => {
    const user = await currentUser(db, request, deps);
    const guild = await requireVisibleGuild(db, request.params.guild_id, user.id);
    return guildApplyState(applyOf(deps), guild.id);
  });

  app.post(
    "/api/applies/:apply_id/overlays",
    { schema: { params: ApplyParams, body: OverlaysSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const row = await ownedApply(deps, request.params.apply_id, org);
      const login = {
        server: request.body.server ?? "",
        connectionId: request.body.connection_id ?? "",
      };
      await writeApplyOverlays(applyOf(deps), row, login, userActor(user));
      return { ok: true };
    },
  );

  app.post(
    "/api/applies/:apply_id/steps/:step_id/verify",
    { schema: { params: StepParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const row = await ownedApply(deps, request.params.apply_id, org);
      return await verifyStep(applyOf(deps), row, request.params.step_id, userActor(user));
    },
  );

  app.post(
    "/api/applies/:apply_id/steps/:step_id/confirm",
    { schema: { params: StepParams, body: StepConfirmSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const row = await ownedApply(deps, request.params.apply_id, org);
      const { skip, later } = request.body;
      if (skip === true) {
        return await skipStep(applyOf(deps), row, request.params.step_id);
      }
      const stepId = request.params.step_id;
      return await confirmStep(applyOf(deps), row, stepId, { later: later === true });
    },
  );

  app.post(
    "/api/applies/:apply_id/activate",
    { schema: { params: ApplyParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const row = await ownedApply(deps, request.params.apply_id, org);
      return await activateApply(applyOf(deps), row, userActor(user));
    },
  );

  app.post(
    "/api/applies/:apply_id/abort",
    { schema: { params: ApplyParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const row = await ownedApply(deps, request.params.apply_id, org);
      return await abortApply(applyOf(deps), row);
    },
  );
}
