import { CATALOG, DEFAULT_MODEL, isMarketplaceModel } from "../llm/catalog.js";
import { newId } from "../lib/ids.js";
import { EventQueue } from "../lib/event.js";
import { AdmissionCoordinator } from "../generation/admission.js";
import { OPEN_POLICY, claimCoachRun, type OrgPolicy } from "../policy/index.js";
import { ConversationRunner } from "../conversation/runner.js";
import type { CapabilityService } from "../capabilities/index.js";
import type { Repositories } from "../db/repositories.js";
import { emptyRecipe } from "../recipes/minimal.js";
import { RecipeStore } from "../recipes/store.js";
import { RecipeApplyService, type ApplyChoices } from "../recipes/apply.js";
import {
  applyAccessEdits,
  applyReview,
  operatorAccessCuts,
  parseAccessEdits,
  parseRecipe,
  unreviewedFields,
} from "../recipes/schema.js";
import { blockingErrors, validateRecipe } from "../recipes/validate.js";
import { BUILDER_DEFAULT_TEMPERATURE, BUILDER_MAX_STEPS } from "./constants.js";
import { BuilderConflictError, BuilderError } from "./errors.js";
import { BuilderStore } from "./store.js";
import { builderConversationTools, builderToolSchemas, type BuilderToolContext } from "./tools.js";
import type { BuilderMcpClient } from "./connected.js";
import { composeBuilderGenerationContext, composeBuilderSystemMessage } from "./system.js";

export type BuilderServiceDeps = {
  repo: Repositories;
  recipes: RecipeStore;
  capabilities: CapabilityService;
  apply: RecipeApplyService;
  admission?: AdmissionCoordinator;
  policy?: OrgPolicy;
  resolveOrgApiKey?: (orgId: string, model: string) => Promise<string | null>;
  mcp?: BuilderMcpClient | null;
};

export class BuilderService {
  store: BuilderStore;
  runner: ConversationRunner;
  admission: AdmissionCoordinator;
  policy: OrgPolicy;

  constructor(public deps: BuilderServiceDeps) {
    this.store = new BuilderStore(deps.repo.pool);
    this.admission = deps.admission ?? new AdmissionCoordinator();
    this.policy = deps.policy ?? OPEN_POLICY;
    this.runner = new ConversationRunner({
      store: this.store,
      admission: this.admission,
      admissionKind: "builder",
      ...(deps.resolveOrgApiKey ? { resolveOrgApiKey: deps.resolveOrgApiKey } : {}),
      policy: this.policy,
      getOrgMonthlyUsage: (orgId, month) => deps.repo.getOrgMonthlyUsage(orgId, month),
      onToolResult: async (sessionId, name, result, publish) => {
        if (name === "builder_write_recipe" && result.ok) {
          await publish(sessionId, "recipe.changed", result);
        }
      },
    });
  }

  async reconcile(): Promise<void> {
    const result = await this.store.pool.query(
      `SELECT * FROM builder_sessions WHERE generation_state IN ('generating', 'cancelling')`,
    );
    for (const row of result.rows as Array<Record<string, unknown>>) {
      await this.runner.reconcile(row);
    }
  }

  viewSession(session: Record<string, unknown>, recipe?: Record<string, unknown> | null): Record<string, unknown> {
    return {
      id: session.id,
      org_id: session.org_id,
      recipe_id: session.recipe_id,
      status: session.status,
      blocked_reason: session.blocked_reason,
      generation_state: session.generation_state,
      generation_number: session.generation_number,
      created_at: session.created_at,
      updated_at: session.updated_at,
      recipe: recipe ?? null,
    };
  }

  async getOwnedSession(
    sessionId: string,
    user: Record<string, unknown>,
    org: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const session = await this.store.getSession(sessionId);
    if (!session || String(session.org_id) !== String(org.id)) {
      throw new BuilderError(404, "builder session not found");
    }
    if (session.created_by_user_id && String(session.created_by_user_id) !== String(user.id)) {
      throw new BuilderError(404, "builder session not found");
    }
    return session;
  }

  async listSessions(orgId: string, userId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.store.listSessions(orgId, userId);
    return rows.map((row) =>
      this.viewSession(row, {
        name: row.recipe_name,
        status: row.recipe_status,
        body_version: row.recipe_body_version,
      }),
    );
  }

  validateModel(model: string): string {
    const token = model.trim() || DEFAULT_MODEL;
    if (
      !isMarketplaceModel(token)
      && ![...CATALOG].some((item) => item.kind === "marketplace" && (item.id.endsWith(`/${token}`) || item.id === token))
    ) {
      throw new BuilderError(422, "unknown model");
    }
    return token;
  }

  async createSession(args: {
    user: Record<string, unknown>;
    org: Record<string, unknown>;
    model: string;
    temperature?: number;
  }): Promise<Record<string, unknown>> {
    const model = this.validateModel(args.model);
    const temperature =
      typeof args.temperature === "number" ? args.temperature : BUILDER_DEFAULT_TEMPERATURE;
    const now = new Date();
    const recipeId = newId("rcp");
    const sessionId = newId("bld");
    const recipeBody = emptyRecipe({
      source: { kind: "builder", session_id: sessionId },
      now,
    });
    const limits = (await this.policy.standing(String(args.org.id))).limits.coach.builder;
    const coachConfig = {
      model,
      temperature,
      max_steps: BUILDER_MAX_STEPS,
      ...limits,
    };
    const system = composeBuilderSystemMessage({
      config: coachConfig,
      recipe: recipeBody,
      expectedBodyVersion: 1,
      now,
    });
    const session = await this.deps.recipes.withTransaction(async (client) => {
      await this.deps.recipes.insert(
        {
          id: recipeId,
          org_id: args.org.id,
          created_by_user_id: args.user.id,
          name: recipeBody.meta.name,
          description: "",
          visibility: "private",
          status: "draft",
          body: recipeBody,
          body_version: 1,
          source_kind: "builder",
          source_builder_session_id: null,
          now,
        },
        client,
      );
      const created = await this.store.insertSession(
        {
          id: sessionId,
          org_id: args.org.id,
          created_by_user_id: args.user.id,
          created_by_name: args.user.name ?? "operator",
          recipe_id: recipeId,
          config_snapshot: {
            ...coachConfig,
            system_prompt_hash: system.hash,
            tool_schemas: builderToolSchemas(),
          },
          status: "active",
          now,
        },
        client,
      );
      await this.deps.recipes.linkBuilderSession(recipeId, sessionId, now, client);
      return created;
    });
    await this.store.insertMessage(
      String(session.id),
      0,
      0,
      { role: "system", content: system.content },
      { source: "builder_system", system_prompt_hash: system.hash },
      now,
    );
    const recipe = await this.deps.recipes.get(recipeId);
    return this.viewSession(session, recipe);
  }

  async recipeFor(session: Record<string, unknown>): Promise<Record<string, unknown>> {
    const recipe = await this.deps.recipes.get(String(session.recipe_id));
    if (!recipe) {
      throw new BuilderError(404, "recipe not found");
    }
    return recipe;
  }

  toolContext(session: Record<string, unknown>): BuilderToolContext {
    return {
      orgId: String(session.org_id),
      capabilities: this.deps.capabilities,
      repo: this.deps.repo,
      mcp: this.deps.mcp ?? null,
      recipeId: String(session.recipe_id),
      recipes: this.deps.recipes,
      validationContext: () => this.deps.apply.validationContext(String(session.org_id)),
    };
  }

  async postMessage(
    session: Record<string, unknown>,
    user: Record<string, unknown>,
    content: string,
  ): Promise<Record<string, unknown>> {
    if (!content.trim()) {
      throw new BuilderError(422, "content must not be empty");
    }
    if (session.status !== "active") {
      throw new BuilderConflictError("session cannot generate");
    }
    const started = await this.store.withSessionLock(String(session.id), async (client, locked) => {
      if (locked.generation_state !== "idle") {
        throw new BuilderConflictError("builder session is already generating");
      }
      const now = new Date();
      await claimCoachRun(this.policy, this.deps.repo, String(locked.org_id), now, client);
      const recipe = await this.deps.recipes.get(String(locked.recipe_id), client);
      const parsed = parseRecipe(recipe?.body);
      const expectedBodyVersion = Number(recipe?.body_version ?? 1);
      const config = (locked.config_snapshot ?? {}) as Record<string, unknown>;
      const system = composeBuilderSystemMessage({ config, recipe: parsed, expectedBodyVersion });
      const generation = Number(locked.generation_number) + 1;
      const seq = await this.store.nextSeq(String(locked.id), client);
      const userMessage = await this.store.insertMessage(
        String(locked.id),
        seq,
        generation,
        { role: "user", content },
        { generation, source: "ui" },
        now,
        client,
      );
      const updated = await this.store.updateSession(
        String(locked.id),
        {
          generation_state: "generating",
          generation_number: generation,
          generation_token: newId("btg"),
          generation_started_at: now,
        },
        now,
        client,
      );
      return { session: updated ?? locked, generation, system, recipe: parsed, expectedBodyVersion, userMessage };
    });
    await this.runner.publish(String(started.session.id), "message.committed", { message: started.userMessage });
    const limits = (await this.policy.standing(String(started.session.org_id))).limits.coach.builder;
    this.runner.start({
      session: started.session,
      user,
      generation: started.generation,
      generationContext: composeBuilderGenerationContext(started.recipe, started.expectedBodyVersion),
      systemContent: started.system.content,
      tools: builderConversationTools(),
      toolContext: this.toolContext(started.session),
      maxTokens: limits.max_tokens,
      maxSteps: BUILDER_MAX_STEPS,
      maxToolCalls: limits.max_tool_calls,
      maxInput: limits.max_input_tokens,
    });
    return this.viewSession(started.session, await this.recipeFor(started.session));
  }

  async cancel(session: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.store.updateSession(String(session.id), { generation_state: "cancelling" }, new Date());
    this.runner.cancel(String(session.id));
    return this.viewSession({ ...session, generation_state: "cancelling" });
  }

  subscribe(sessionId: string): EventQueue<[string, Record<string, unknown>]> {
    return this.runner.subscribe(sessionId);
  }

  unsubscribe(sessionId: string, queue: EventQueue<[string, Record<string, unknown>]>): void {
    this.runner.unsubscribe(sessionId, queue);
  }

  async writeRecipe(
    session: Record<string, unknown>,
    expectedVersion: number,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const parsed = parseRecipe(body);
    const written = await this.deps.recipes.writeBody(
      String(session.recipe_id),
      expectedVersion,
      parsed,
      { name: parsed.meta.name, description: parsed.meta.description },
      new Date(),
    );
    return written;
  }

  async reviewField(
    session: Record<string, unknown>,
    path: string,
    action: "confirm" | "edit",
    value?: string,
  ): Promise<Record<string, unknown>> {
    const row = await this.recipeFor(session);
    const recipe = parseRecipe(row.body);
    applyReview(recipe, path, action, value);
    return this.deps.recipes.writeBody(
      String(row.id),
      Number(row.body_version),
      recipe,
      {},
      new Date(),
    );
  }

  async editAccess(session: Record<string, unknown>, input: unknown): Promise<Record<string, unknown>> {
    const row = await this.recipeFor(session);
    const recipe = parseRecipe(row.body);
    const cuts = applyAccessEdits(recipe, parseAccessEdits(input));
    const written = await this.deps.recipes.writeBody(
      String(row.id),
      Number(row.body_version),
      recipe,
      {},
      new Date(),
    );
    return { ...written, access_cuts: cuts };
  }

  async validate(session: Record<string, unknown>): Promise<Record<string, unknown>> {
    const row = await this.recipeFor(session);
    const recipe = parseRecipe(row.body);
    const ctx = await this.deps.apply.validationContext(String(session.org_id));
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

  async publish(session: Record<string, unknown>): Promise<Record<string, unknown>> {
    const row = await this.recipeFor(session);
    const recipe = parseRecipe(row.body);
    const ctx = await this.deps.apply.validationContext(String(session.org_id));
    ctx.groupLimit = recipe.guild.group_agent_message_limit;
    const errors = blockingErrors(validateRecipe(recipe, ctx));
    if (errors.length) {
      throw new BuilderError(422, errors.map((item) => item.message).join("; "));
    }
    return (await this.deps.recipes.setStatus(String(row.id), "ready", new Date())) ?? row;
  }

  async deploy(session: Record<string, unknown>, org: Record<string, unknown>, user: Record<string, unknown>, choices: ApplyChoices = {}) {
    const recipe = await this.recipeFor(session);
    return this.deps.apply.createSkeleton(org, user, recipe, choices);
  }
}
