import {
  assertModelConnected,
  coreModelCredentials,
  type ModelCredentialsProvider,
  ModelNotConnectedError,
  modelProviderStore,
} from "../llm/credentials.js";
import { isMarketplaceModel } from "../llm/providers.js";
import { newId } from "../lib/ids.js";
import { EventQueue } from "../lib/event.js";
import { AdmissionCoordinator } from "../generation/admission.js";
import { OPEN_POLICY, claimCoachRun, coachRunClaims, type OrgPolicy } from "../policy/index.js";
import { ConversationRunner } from "../conversation/runner.js";
import type { CapabilityService } from "../capabilities/index.js";
import { assignGuildLooks } from "../avatars/looks.js";
import { emptyRecipe } from "../recipes/minimal.js";
import { addRecipeDraft, linkRecipeToBuilder, markRecipeReady, writeRecipe } from "../recipes/library.js";
import { getRecipe, type RecipeRow } from "../db/recipes.js";
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
import {
  BUILDER_DEFAULT_TEMPERATURE,
  BUILDER_MAX_STEPS,
  BUILDER_TOOL_RESULT_STUB_HINT,
} from "./constants.js";
import { BuilderConflictError, BuilderError } from "./errors.js";
import { BuilderStore } from "./store.js";
import { builderConversationTools, builderToolSchemas, type BuilderToolContext } from "./tools.js";
import type { BuilderMcpClient } from "./connected.js";
import { composeBuilderGenerationContext, composeBuilderSystemMessage } from "./system.js";
import { connectedDatabase } from "./connected.js";
import { type Queryable, withTransaction } from "../db/pg.js";

export type BuilderServiceDeps = {
  db: Queryable;
  capabilities: CapabilityService;
  apply: RecipeApplyService;
  admission?: AdmissionCoordinator;
  policy?: OrgPolicy;
  /** What the coach's model provider is called with; core's own rows when absent. */
  credentials?: ModelCredentialsProvider;
  mcp?: BuilderMcpClient | null;
  /** The agent Guidelines template the coach is shown; the repository's own when absent. */
  guidelinesPath?: string;
};

export class BuilderService {
  store: BuilderStore;
  runner: ConversationRunner;
  admission: AdmissionCoordinator;
  policy: OrgPolicy;
  credentials: ModelCredentialsProvider;

  constructor(public deps: BuilderServiceDeps) {
    this.store = new BuilderStore(deps.db);
    this.admission = deps.admission ?? new AdmissionCoordinator();
    this.policy = deps.policy ?? OPEN_POLICY;
    this.credentials = deps.credentials ?? coreModelCredentials(modelProviderStore(deps.db));
    this.runner = new ConversationRunner({
      store: this.store,
      admission: this.admission,
      admissionKind: "builder",
      stubHint: BUILDER_TOOL_RESULT_STUB_HINT,
      credentials: this.credentials,
      policy: this.policy,
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

  viewSession(
    session: Record<string, unknown>,
    recipe?: Record<string, unknown> | null,
  ): Record<string, unknown> {
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

  /** The coach's model: a marketplace model whose provider the organisation has connected. */
  async validateModel(orgId: string, model: string): Promise<string> {
    const id = model.trim();
    if (!id) {
      throw new BuilderError(422, "model is required");
    }
    if (!isMarketplaceModel(id)) {
      throw new BuilderError(422, "the coach needs a marketplace model");
    }
    try {
      await assertModelConnected(this.credentials, orgId, id);
    } catch (error) {
      if (error instanceof ModelNotConnectedError) {
        throw new BuilderError(422, error.message);
      }
      throw error;
    }
    return id;
  }

  async createSession(args: {
    user: Record<string, unknown>;
    org: Record<string, unknown>;
    model: string;
    temperature?: number;
  }): Promise<Record<string, unknown>> {
    const model = await this.validateModel(String(args.org.id), args.model);
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
      guidelinesPath: this.deps.guidelinesPath,
      now,
    });
    const session = await withTransaction(this.deps.db, async (client) => {
      await addRecipeDraft(
        client,
        {
          recipeId,
          orgId: String(args.org.id),
          createdByUserId: String(args.user.id),
          name: recipeBody.meta.name,
          description: "",
          body: recipeBody,
          sourceKind: "builder",
        },
        now,
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
      await linkRecipeToBuilder(client, recipeId, sessionId, now);
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
    const recipe = await getRecipe(this.deps.db, recipeId);
    return this.viewSession(session, recipe);
  }

  async recipeFor(session: Record<string, unknown>): Promise<RecipeRow> {
    const recipe = await getRecipe(this.deps.db, String(session.recipe_id));
    if (!recipe) {
      throw new BuilderError(404, "recipe not found");
    }
    return recipe;
  }

  toolContext(session: Record<string, unknown>): BuilderToolContext {
    return {
      orgId: String(session.org_id),
      capabilities: this.deps.capabilities,
      db: connectedDatabase(this.deps.db),
      mcp: this.deps.mcp ?? null,
      recipeId: String(session.recipe_id),
      connection: this.deps.db,
      coachModel: String((session.config_snapshot as Record<string, unknown> | null)?.model ?? ""),
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
      await claimCoachRun(this.policy, coachRunClaims(client), String(locked.org_id), now);
      const recipe = await getRecipe(client, String(locked.recipe_id));
      const parsed = parseRecipe(recipe?.body);
      const expectedBodyVersion = Number(recipe?.body_version ?? 1);
      const config = (locked.config_snapshot ?? {}) as Record<string, unknown>;
      const system = composeBuilderSystemMessage({
        config,
        recipe: parsed,
        expectedBodyVersion,
        guidelinesPath: this.deps.guidelinesPath,
      });
      await this.store.updateMessage(
        String(locked.id),
        0,
        { role: "system", content: system.content },
        { source: "builder_system", system_prompt_hash: system.hash, refreshed: true },
        client,
      );
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
      return {
        session: updated ?? locked,
        generation,
        system,
        recipe: parsed,
        expectedBodyVersion,
        userMessage,
      };
    });
    await this.runner.publish(String(started.session.id), "message.committed", {
      message: started.userMessage,
    });
    const limits = (await this.policy.standing(String(started.session.org_id))).limits.coach
      .builder;
    this.runner.start({
      session: started.session,
      user,
      generation: started.generation,
      generationContext: composeBuilderGenerationContext(
        started.recipe,
        started.expectedBodyVersion,
      ),
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
    await this.store.updateSession(
      String(session.id),
      { generation_state: "cancelling" },
      new Date(),
    );
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
    return writeRecipe(
      this.deps.db,
      { id: String(session.recipe_id), body_version: expectedVersion },
      { body: parsed, name: parsed.meta.name, description: parsed.meta.description },
      new Date(),
    );
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
    return writeRecipe(this.deps.db, row, { body: recipe }, new Date());
  }

  async editAccess(
    session: Record<string, unknown>,
    input: unknown,
  ): Promise<Record<string, unknown>> {
    const row = await this.recipeFor(session);
    const recipe = parseRecipe(row.body);
    const cuts = applyAccessEdits(recipe, parseAccessEdits(input));
    const written = await writeRecipe(this.deps.db, row, { body: recipe }, new Date());
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
    let current = row;
    if (assignGuildLooks(recipe.roles)) {
      current = await writeRecipe(this.deps.db, row, { body: recipe }, new Date());
    }
    const ctx = await this.deps.apply.validationContext(String(session.org_id));
    ctx.groupLimit = recipe.guild.group_agent_message_limit;
    const errors = blockingErrors(validateRecipe(recipe, ctx));
    if (errors.length) {
      throw new BuilderError(422, errors.map((item) => item.message).join("; "));
    }
    return markRecipeReady(this.deps.db, current, new Date());
  }

  async deploy(
    session: Record<string, unknown>,
    org: Record<string, unknown>,
    user: Record<string, unknown>,
    choices: ApplyChoices = {},
  ) {
    const recipe = await this.recipeFor(session);
    return this.deps.apply.createSkeleton(org, user, recipe, choices);
  }
}
