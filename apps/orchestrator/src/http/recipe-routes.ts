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
  reviewRecipe,
  validateLibraryRecipe,
} from "../recipes/library.js";
import type { FastifyInstance } from "fastify";
import { requireVisibleGuild } from "../guilds/access.js";
import { loadOperatorActor } from "../artifacts/actors.js";
import { userActor } from "../lib/change-actor.js";
import { parseReviewAction } from "../recipes/review.js";
import { RecipeConflictError, RecipeError } from "../recipes/errors.js";
import { PolicyError } from "../policy/index.js";
import type { AppDeps } from "./deps.js";
import { RegistryError } from "../registry/index.js";
import { latestEntries, registryHttp, registryOf } from "./admin-registry-routes.js";
import { HttpError, recipeConflictHttp } from "./errors.js";
import { currentOrg, currentUser } from "./identity.js";
import { bodyOf, param } from "./request.js";
import type { OrgMembershipRow } from "../db/orgs.js";
import { confirmStep, skipStep, verifyStep, writeApplyOverlays } from "../recipes/checklist.js";
import { abortApply, activateApply, guildApplyState, orgApply } from "../recipes/lifecycle.js";
import { previewApply } from "../recipes/plan.js";
import { createSkeleton } from "../recipes/skeleton.js";

function mapError(error: unknown): never {
  if (error instanceof RecipeConflictError) {
    throw recipeConflictHttp(error);
  }
  if (
    error instanceof RecipeError ||
    error instanceof PolicyError
  ) {
    throw new HttpError(error.status, error.message);
  }
  throw error;
}

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

export async function registerRecipeRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;

  app.get("/api/recipes", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    return orgRecipes(db, org.id);
  });

  app.post("/api/recipes/import", async (request, reply) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    try {
      const body = bodyOf(request);
      const row = await importRecipe(db, body.recipe ?? body, { orgId: org.id, userId: user.id });
      reply.code(201);
      return row;
    } catch (error) {
      mapError(error);
    }
  });

  app.get("/api/recipes/registry", async (request) => {
    await currentUser(db, request, deps);
    const client = registryOf(deps);
    if (client === null) {
      return { offline: true, url: null, recipes: [] };
    }
    try {
      const index = await client.index();
      return { offline: false, url: client.baseUrl, recipes: latestEntries(index.recipes, (entry) => entry.name) };
    } catch (error) {
      registryHttp(error);
    }
  });

  app.post("/api/recipes/registry/import", async (request, reply) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    const body = bodyOf(request);
    const client = registryOf(deps);
    if (client === null) {
      throw new HttpError(409, "the box is offline: REGISTRY_URL is set empty");
    }
    try {
      const name = typeof body.name === "string" ? body.name : "";
      const version = typeof body.version === "string" && body.version ? body.version : undefined;
      const row = await importRegistryRecipe(db, client, { name, version }, { orgId: org.id, userId: user.id });
      reply.code(201);
      return row;
    } catch (error) {
      if (error instanceof RegistryError) {
        registryHttp(error);
      }
      mapError(error);
    }
  });

  app.post("/api/guilds/:guild_id/recipes", async (request, reply) => {
    const user = await currentUser(db, request, deps);
    await currentOrg(db, request, user);
    if (!deps.artifacts) {
      throw new HttpError(422, "recipes are not available");
    }
    try {
      const guild = await requireVisibleGuild(db, param(request, "guild_id"), user.id);
      const body = bodyOf(request);
      const actor = await loadOperatorActor(db, user, { orgId: guild.org_id, guildId: guild.id });
      const row = await captureRecipe(
        { db, artifacts: deps.artifacts, scripts: deps.scripts, schedules: deps.schedules },
        guild,
        Array.isArray(body.include_notes) ? (body.include_notes as string[]) : [],
        actor,
      );
      reply.code(201);
      return row;
    } catch (error) {
      mapError(error);
    }
  });

  app.get("/api/recipes/:recipe_id", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    return ownedRecipe(deps, param(request, "recipe_id"), org);
  });

  app.put("/api/recipes/:recipe_id", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    const body = bodyOf(request);
    try {
      const row = await ownedRecipe(deps, param(request, "recipe_id"), org);
      return await changeRecipe(db, row, {
        bodyVersion: Number(body.expected_body_version ?? row.body_version),
        document: body.recipe,
        name: typeof body.name === "string" ? body.name : undefined,
        description: typeof body.description === "string" ? body.description : undefined,
      });
    } catch (error) {
      mapError(error);
    }
  });

  app.post("/api/recipes/:recipe_id/access", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    const body = bodyOf(request);
    try {
      const row = await ownedRecipe(deps, param(request, "recipe_id"), org);
      return await editRecipeAccess(db, row, parseAccessEdits(body));
    } catch (error) {
      mapError(error);
    }
  });

  app.post("/api/recipes/:recipe_id/review", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    const body = bodyOf(request);
    try {
      const row = await ownedRecipe(deps, param(request, "recipe_id"), org);
      return await reviewRecipe(db, row, String(body.path ?? ""), parseReviewAction(body));
    } catch (error) {
      mapError(error);
    }
  });

  app.delete("/api/recipes/:recipe_id", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    if (!(await deleteOrgRecipe(db, org.id, param(request, "recipe_id")))) {
      throw new HttpError(404, "recipe not found");
    }
    return { ok: true };
  });

  app.post("/api/recipes/:recipe_id/validate", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    try {
      const row = await ownedRecipe(deps, param(request, "recipe_id"), org);
      return await validateLibraryRecipe(applyOf(deps), row);
    } catch (error) {
      mapError(error);
    }
  });

  app.post("/api/recipes/:recipe_id/publish", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    try {
      const row = await ownedRecipe(deps, param(request, "recipe_id"), org);
      return await publishRecipe(applyOf(deps), row);
    } catch (error) {
      mapError(error);
    }
  });

  app.get("/api/recipes/:recipe_id/export", async (request, reply) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    try {
      const recipe = exportRecipe(await ownedRecipe(deps, param(request, "recipe_id"), org));
      reply.header("content-type", "application/json");
      return recipe;
    } catch (error) {
      mapError(error);
    }
  });

  app.post("/api/recipes/:recipe_id/preview", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    try {
      const row = await ownedRecipe(deps, param(request, "recipe_id"), org);
      return await previewApply(applyOf(deps), { org, recipeRow: row, user }, bodyOf(request));
    } catch (error) {
      mapError(error);
    }
  });

  app.post("/api/recipes/:recipe_id/apply", async (request, reply) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    try {
      const row = await ownedRecipe(deps, param(request, "recipe_id"), org);
      const created = await createSkeleton(applyOf(deps), { org, user, recipeRow: row }, bodyOf(request));
      reply.code(201);
      return created;
    } catch (error) {
      mapError(error);
    }
  });

  app.get("/api/applies/:apply_id", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    return ownedApply(deps, param(request, "apply_id"), org);
  });

  app.get("/api/guilds/:guild_id/apply", async (request) => {
    const user = await currentUser(db, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), user.id);
    return guildApplyState(applyOf(deps), guild.id);
  });

  app.post("/api/applies/:apply_id/overlays", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    try {
      const row = await ownedApply(deps, param(request, "apply_id"), org);
      const body = bodyOf(request);
      await writeApplyOverlays(
        applyOf(deps),
        row,
        { server: String(body.server ?? ""), connectionId: String(body.connection_id ?? "") },
        userActor(user),
      );
      return { ok: true };
    } catch (error) {
      mapError(error);
    }
  });

  app.post("/api/applies/:apply_id/steps/:step_id/verify", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    try {
      const row = await ownedApply(deps, param(request, "apply_id"), org);
      return await verifyStep(applyOf(deps), row, param(request, "step_id"), userActor(user));
    } catch (error) {
      mapError(error);
    }
  });

  app.post("/api/applies/:apply_id/steps/:step_id/confirm", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    try {
      const row = await ownedApply(deps, param(request, "apply_id"), org);
      const body = bodyOf(request);
      if (body.skip === true) {
        return await skipStep(applyOf(deps), row, param(request, "step_id"));
      }
      return await confirmStep(applyOf(deps), row, param(request, "step_id"), { later: body.later === true });
    } catch (error) {
      mapError(error);
    }
  });

  app.post("/api/applies/:apply_id/activate", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    try {
      const row = await ownedApply(deps, param(request, "apply_id"), org);
      return await activateApply(applyOf(deps), row, userActor(user));
    } catch (error) {
      mapError(error);
    }
  });

  app.post("/api/applies/:apply_id/abort", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    try {
      const row = await ownedApply(deps, param(request, "apply_id"), org);
      return await abortApply(applyOf(deps), row);
    } catch (error) {
      mapError(error);
    }
  });
}
