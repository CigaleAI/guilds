import type { FastifyInstance, FastifyRequest } from "fastify";
import { newId } from "../lib/ids.js";
import { captureGuild } from "../recipes/capture.js";
import {
  applyAccessEdits,
  applyReview,
  hasForbiddenSecrets,
  operatorAccessCuts,
  parseAccessEdits,
  parseRecipe,
  resetReview,
  unreviewedFields,
  type RecipeDocument,
} from "../recipes/schema.js";
import { RecipeConflictError, RecipeError } from "../recipes/errors.js";
import { blockingErrors, validateRecipe } from "../recipes/validate.js";
import { PolicyError } from "../policy/index.js";
import type { AppDeps } from "./deps.js";
import { pickEntry, RegistryError } from "../registry/index.js";
import { latestEntries, registryHttp, registryOf } from "./admin-registry-routes.js";
import { HttpError, recipeConflictHttp } from "./errors.js";
import { currentOrg, currentUser } from "./identity.js";
import { ownedGuild } from "./items.js";

function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

function param(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, string>)[name];
  if (typeof value !== "string") {
    throw new HttpError(404, "Not Found");
  }
  return value;
}

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

function recipesOf(deps: AppDeps) {
  if (!deps.recipes) {
    throw new HttpError(422, "recipes are not available");
  }
  return deps.recipes;
}

function applyOf(deps: AppDeps) {
  if (!deps.apply) {
    throw new HttpError(422, "recipe apply is not available");
  }
  return deps.apply;
}

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

async function ownedRecipe(deps: AppDeps, recipeId: string, org: Record<string, unknown>) {
  const row = await recipesOf(deps).get(recipeId);
  if (!row || String(row.org_id) !== String(org.id)) {
    throw new HttpError(404, "recipe not found");
  }
  return row;
}

async function ownedApply(deps: AppDeps, applyId: string, org: Record<string, unknown>) {
  const row = await applyOf(deps).get(applyId);
  if (!row || String(row.org_id) !== String(org.id)) {
    throw new HttpError(404, "apply not found");
  }
  return row;
}

export async function registerRecipeRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { repo } = deps;

  app.get("/api/recipes", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    return recipesOf(deps).list(String(org.id));
  });

  /** Adds an imported document to the organisation's library as a private draft. */
  async function importRecipe(org: Record<string, unknown>, user: Record<string, unknown>, document: unknown) {
    const parsed = resetImported(parseRecipe(document));
    if (hasForbiddenSecrets(parsed)) {
      throw new RecipeError("recipe must not contain secrets or ciphertext");
    }
    return recipesOf(deps).insert({
      id: newId("rcp"),
      org_id: org.id,
      created_by_user_id: user.id,
      name: parsed.meta.name,
      description: parsed.meta.description,
      visibility: "private",
      status: "draft",
      body: parsed,
      body_version: 1,
      source_kind: "file",
      now: new Date(),
    });
  }

  app.post("/api/recipes/import", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const body = bodyOf(request);
      const row = await importRecipe(org, user, body.recipe ?? body);
      reply.code(201);
      return row;
    } catch (error) {
      mapError(error);
    }
  });

  app.get("/api/recipes/registry", async (request) => {
    await currentUser(repo, request, deps);
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
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const body = bodyOf(request);
    const client = registryOf(deps);
    if (client === null) {
      throw new HttpError(409, "the box is offline: REGISTRY_URL is set empty");
    }
    try {
      const name = typeof body.name === "string" ? body.name : "";
      const version = typeof body.version === "string" && body.version ? body.version : undefined;
      const entry = pickEntry((await client.index()).recipes.filter((item) => item.name === name), version);
      if (entry === null) {
        throw new RegistryError(version ? `the registry has no recipe ${name}@${version}` : `the registry has no recipe ${name}`, 404);
      }
      const row = await importRecipe(org, user, await client.recipe(entry));
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
    const user = await currentUser(repo, request, deps);
    await currentOrg(repo, request, user);
    if (!deps.artifacts || !deps.recipes) {
      throw new HttpError(422, "recipes are not available");
    }
    try {
      const guild = await ownedGuild(repo, param(request, "guild_id"), user);
      const body = bodyOf(request);
      const parsed = await captureGuild(
        {
          repo,
          artifacts: deps.artifacts,
          scripts: deps.scripts,
          schedules: deps.schedules,
        },
        {
          guild,
          user,
          includeNotes: Array.isArray(body.include_notes) ? (body.include_notes as string[]) : [],
        },
      );
      const now = new Date();
      const row = await deps.recipes.insert({
        id: newId("rcp"),
        org_id: guild.org_id,
        created_by_user_id: user.id,
        name: parsed.meta.name,
        description: parsed.meta.description,
        visibility: "private",
        status: "draft",
        body: parsed,
        body_version: 1,
        source_kind: "guild",
        source_guild_id: guild.id,
        now,
      });
      reply.code(201);
      return row;
    } catch (error) {
      mapError(error);
    }
  });

  app.get("/api/recipes/:recipe_id", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    return ownedRecipe(deps, param(request, "recipe_id"), org);
  });

  app.put("/api/recipes/:recipe_id", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const body = bodyOf(request);
    try {
      const row = await ownedRecipe(deps, param(request, "recipe_id"), org);
      const parsed = parseRecipe(body.recipe ?? row.body);
      return await recipesOf(deps).writeBody(
        String(row.id),
        Number(body.expected_body_version ?? row.body_version),
        parsed,
        {
          name: typeof body.name === "string" ? body.name : parsed.meta.name,
          description: typeof body.description === "string" ? body.description : parsed.meta.description,
        },
        new Date(),
      );
    } catch (error) {
      mapError(error);
    }
  });

  app.post("/api/recipes/:recipe_id/access", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const body = bodyOf(request);
    try {
      const row = await ownedRecipe(deps, param(request, "recipe_id"), org);
      const recipe = parseRecipe(row.body);
      const cuts = applyAccessEdits(recipe, parseAccessEdits(body));
      const written = await recipesOf(deps).writeBody(String(row.id), Number(row.body_version), recipe, {}, new Date());
      return { ...written, access_cuts: cuts };
    } catch (error) {
      mapError(error);
    }
  });

  app.post("/api/recipes/:recipe_id/review", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const body = bodyOf(request);
    try {
      const row = await ownedRecipe(deps, param(request, "recipe_id"), org);
      const recipe = parseRecipe(row.body);
      applyReview(recipe, String(body.path ?? ""), body.action === "edit" ? "edit" : "confirm", typeof body.value === "string" ? body.value : undefined);
      return await recipesOf(deps).writeBody(String(row.id), Number(row.body_version), recipe, {}, new Date());
    } catch (error) {
      mapError(error);
    }
  });

  app.delete("/api/recipes/:recipe_id", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const row = await ownedRecipe(deps, param(request, "recipe_id"), org);
    await recipesOf(deps).delete(String(row.id));
    return { ok: true };
  });

  app.post("/api/recipes/:recipe_id/validate", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const row = await ownedRecipe(deps, param(request, "recipe_id"), org);
      const recipe = parseRecipe(row.body);
      const ctx = await applyOf(deps).validationContext(String(org.id), recipe);
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
    } catch (error) {
      mapError(error);
    }
  });

  app.post("/api/recipes/:recipe_id/publish", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const row = await ownedRecipe(deps, param(request, "recipe_id"), org);
      const recipe = parseRecipe(row.body);
      const ctx = await applyOf(deps).validationContext(String(org.id));
      ctx.groupLimit = recipe.guild.group_agent_message_limit;
      const errors = blockingErrors(validateRecipe(recipe, ctx));
      if (errors.length) {
        throw new RecipeError(errors.map((item) => item.message).join("; "));
      }
      return (await recipesOf(deps).setStatus(String(row.id), "ready", new Date())) ?? row;
    } catch (error) {
      mapError(error);
    }
  });

  app.get("/api/recipes/:recipe_id/export", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const row = await ownedRecipe(deps, param(request, "recipe_id"), org);
    if (row.status === "draft") {
      throw new HttpError(409, "export refused while draft");
    }
    const recipe = parseRecipe(row.body);
    if (hasForbiddenSecrets(recipe)) {
      throw new HttpError(422, "recipe must not contain secrets");
    }
    reply.header("content-type", "application/json");
    return recipe;
  });

  app.post("/api/recipes/:recipe_id/preview", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const row = await ownedRecipe(deps, param(request, "recipe_id"), org);
      return await applyOf(deps).preview(org, row, bodyOf(request), user);
    } catch (error) {
      mapError(error);
    }
  });

  app.post("/api/recipes/:recipe_id/apply", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const row = await ownedRecipe(deps, param(request, "recipe_id"), org);
      const created = await applyOf(deps).createSkeleton(org, user, row, bodyOf(request));
      reply.code(201);
      return created;
    } catch (error) {
      mapError(error);
    }
  });

  app.get("/api/applies/:apply_id", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    return ownedApply(deps, param(request, "apply_id"), org);
  });

  app.get("/api/guilds/:guild_id/apply", async (request) => {
    const user = await currentUser(repo, request, deps);
    const guild = await ownedGuild(repo, param(request, "guild_id"), user);
    return { apply: await applyOf(deps).listOpenForGuild(String(guild.id)) };
  });

  app.post("/api/applies/:apply_id/overlays", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const row = await ownedApply(deps, param(request, "apply_id"), org);
      const body = bodyOf(request);
      await applyOf(deps).writeOverlays(row, String(body.server ?? ""), String(body.connection_id ?? ""));
      return { ok: true };
    } catch (error) {
      mapError(error);
    }
  });

  app.post("/api/applies/:apply_id/steps/:step_id/verify", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const row = await ownedApply(deps, param(request, "apply_id"), org);
      return await applyOf(deps).verifyStep(row, param(request, "step_id"));
    } catch (error) {
      mapError(error);
    }
  });

  app.post("/api/applies/:apply_id/steps/:step_id/confirm", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const row = await ownedApply(deps, param(request, "apply_id"), org);
      const body = bodyOf(request);
      return await applyOf(deps).confirmStep(row, param(request, "step_id"), {
        later: body.later === true,
        skip: body.skip === true,
      });
    } catch (error) {
      mapError(error);
    }
  });

  app.post("/api/applies/:apply_id/activate", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const row = await ownedApply(deps, param(request, "apply_id"), org);
      return await applyOf(deps).activate(row);
    } catch (error) {
      mapError(error);
    }
  });

  app.post("/api/applies/:apply_id/abort", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const row = await ownedApply(deps, param(request, "apply_id"), org);
      return await applyOf(deps).abort(row);
    } catch (error) {
      mapError(error);
    }
  });
}
