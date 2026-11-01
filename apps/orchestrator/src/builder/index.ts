import { getBuilderSession, insertBuilderSession, listBuilderSessions, listGeneratingBuilderSessions, lockBuilderSession, updateBuilderSession, type BuilderSessionRow } from "../db/builder.js";
import type { RecipeDocument } from "../db/schema/index.js";
import {
  type ConversationMessageRow,
  type ConversationUsageRow,
  conversationUsageByOrg,
  insertConversationMessage,
  listConversationMessages,
  nextConversationSeq,
  updateConversationMessage,
} from "../db/conversations.js";
import {
  assertModelConnected,
  coreModelCredentials,
  type ModelCredentialsProvider,
  ModelNotConnectedError,
} from "../llm/credentials.js";
import { isMarketplaceModel } from "../llm/providers.js";
import { newId } from "../lib/ids.js";
import { EventQueue } from "../lib/event.js";
import { AdmissionCoordinator } from "../admission/coordinator.js";
import { OPEN_POLICY, claimCoachRun, type OrgPolicy } from "../policy/index.js";
import { ConversationRunner } from "../conversation/runner.js";
import type { CapabilityService } from "../capabilities/index.js";
import { assignGuildLooks } from "../avatars/looks.js";
import type { AccessCut, AccessEdit } from "../recipes/access-edits.js";
import { emptyRecipe } from "../recipes/minimal.js";
import {
  addRecipeDraft,
  editRecipeAccess,
  linkRecipeToBuilder,
  publishRecipe,
  reviewRecipe,
  validateLibraryRecipe,
  writeRecipe,
  type RecipeValidation,
} from "../recipes/library.js";
import { getRecipe, type RecipeRow } from "../db/recipes.js";
import type { ApplyChoices, RecipeApply } from "../recipes/apply.js";
import type { RecipeApplyRow } from "../db/recipe-applies.js";
import type { ReviewAction } from "../recipes/review.js";
import { createSkeleton } from "../recipes/skeleton.js";
import {
  BUILDER_DEFAULT_TEMPERATURE,
  BUILDER_MAX_STEPS,
  BUILDER_TOOL_RESULT_STUB_HINT,
} from "./constants.js";
import { ConversationConflictError, ConversationError } from "../conversation/errors.js";
import { builderConversationTools, builderToolSchemas, type BuilderToolContext } from "./tools.js";
import type { BuilderMcpClient } from "./connected.js";
import { composeBuilderGenerationContext, composeBuilderSystemMessage, type CoachSettings } from "./system.js";
import { connectedDatabase } from "./connected.js";
import { type Queryable, withTransaction } from "../db/pg.js";
import type { UserRow } from "../db/users.js";
import type { OrgMembershipRow } from "../db/orgs.js";

/** A Builder session's state as the operator app shows it: whose it is, the recipe it writes, and where its generation stands. */
export type BuilderSessionState = Pick<
  BuilderSessionRow,
  | "id"
  | "org_id"
  | "recipe_id"
  | "status"
  | "blocked_reason"
  | "generation_state"
  | "generation_number"
  | "created_at"
  | "updated_at"
>;

/** A Builder session as the operator app opens it: its state and the recipe it writes, null once it is being cancelled. */
export type BuilderSessionView = BuilderSessionState & { recipe: RecipeRow | null };

/** A Builder session as its list shows it: its state, and the name, status and version of its recipe. */
export type BuilderSessionSummary = BuilderSessionState & {
  recipe: { name: RecipeRow["name"] | null; status: RecipeRow["status"] | null; body_version: RecipeRow["body_version"] | null };
};

/** `session`'s state as the operator app shows it. */
function sessionState(session: BuilderSessionRow): BuilderSessionState {
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
  };
}

export type BuilderServiceDeps = {
  db: Queryable;
  capabilities: CapabilityService;
  apply: RecipeApply;
  admission?: AdmissionCoordinator;
  policy?: OrgPolicy;
  /** What the coach's model provider is called with; core's own rows when absent. */
  credentials?: ModelCredentialsProvider;
  mcp?: BuilderMcpClient | null;
  /** The agent Guidelines template the coach is shown; the repository's own when absent. */
  guidelinesPath?: string;
};

export class BuilderService {
  runner: ConversationRunner;
  admission: AdmissionCoordinator;
  policy: OrgPolicy;
  credentials: ModelCredentialsProvider;

  constructor(public deps: BuilderServiceDeps) {
    this.admission = deps.admission ?? new AdmissionCoordinator();
    this.policy = deps.policy ?? OPEN_POLICY;
    this.credentials = deps.credentials ?? coreModelCredentials(deps.db);
    this.runner = new ConversationRunner({
      db: deps.db,
      kind: "builder",
      admission: this.admission,
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
    for (const row of await listGeneratingBuilderSessions(this.deps.db)) {
      await this.runner.reconcile(row);
    }
  }

  async getOwnedSession(
    sessionId: string,
    user: UserRow,
    org: OrgMembershipRow,
  ): Promise<BuilderSessionRow> {
    const session = await getBuilderSession(this.deps.db, sessionId);
    if (!session || session.org_id !== org.id) {
      throw new ConversationError(404, "builder session not found");
    }
    if (session.created_by_user_id && session.created_by_user_id !== user.id) {
      throw new ConversationError(404, "builder session not found");
    }
    return session;
  }

  async listSessions(orgId: string, userId: string): Promise<BuilderSessionSummary[]> {
    const rows = await listBuilderSessions(this.deps.db, orgId, userId);
    return rows.map((row) => ({
      ...sessionState(row),
      recipe: { name: row.recipe_name, status: row.recipe_status, body_version: row.recipe_body_version },
    }));
  }

  /** The coach's model: a marketplace model whose provider the organisation has connected. */
  async validateModel(orgId: string, model: string): Promise<string> {
    const id = model.trim();
    if (!id) {
      throw new ConversationError(422, "model is required");
    }
    if (!isMarketplaceModel(id)) {
      throw new ConversationError(422, "the coach needs a marketplace model");
    }
    try {
      await assertModelConnected(this.credentials, orgId, id);
    } catch (error) {
      if (error instanceof ModelNotConnectedError) {
        throw new ConversationError(422, error.message);
      }
      throw error;
    }
    return id;
  }

  /** A session on a new draft recipe, coached by `model` at `temperature` (the Builder default when undefined). */
  async createSession(
    user: UserRow,
    org: OrgMembershipRow,
    modelRef: string,
    temperature: number | undefined,
  ): Promise<BuilderSessionView> {
    const model = await this.validateModel(String(org.id), modelRef);
    const coachTemperature = temperature ?? BUILDER_DEFAULT_TEMPERATURE;
    const now = new Date();
    const recipeId = newId("rcp");
    const sessionId = newId("bld");
    const recipeBody = emptyRecipe({
      source: { kind: "builder", session_id: sessionId },
      now,
    });
    const limits = (await this.policy.standing(String(org.id))).limits.coach.builder;
    const coachConfig: CoachSettings = {
      model,
      temperature: coachTemperature,
      max_steps: BUILDER_MAX_STEPS,
      ...limits,
    };
    const system = composeBuilderSystemMessage(
      coachConfig,
      { body: recipeBody, body_version: 1 },
      this.deps.guidelinesPath,
      now,
    );
    const session = await withTransaction(this.deps.db, async (client) => {
      await addRecipeDraft(
        client,
        {
          recipeId,
          orgId: String(org.id),
          createdByUserId: String(user.id),
          name: recipeBody.meta.name,
          description: "",
          body: recipeBody,
          sourceKind: "builder",
        },
        now,
      );
      const created = await insertBuilderSession(
        client,
        {
          sessionId,
          orgId: String(org.id),
          createdByUserId: String(user.id),
          createdByName: user.name,
          recipeId,
          configSnapshot: {
            ...coachConfig,
            system_prompt_hash: system.hash,
            tool_schemas: builderToolSchemas(),
          },
        },
        now,
      );
      await linkRecipeToBuilder(client, recipeId, sessionId, now);
      return created;
    });
    await insertConversationMessage(
      this.deps.db,
      "builder",
      {
        session_id: session.id,
        seq: 0,
        generation: 0,
        payload: { role: "system", content: system.content },
        metadata: { source: "builder_system", system_prompt_hash: system.hash },
      },
      now,
    );
    const recipe = await getRecipe(this.deps.db, recipeId);
    return { ...sessionState(session), recipe };
  }

  private async recipeFor(session: BuilderSessionRow): Promise<RecipeRow> {
    const recipe = await getRecipe(this.deps.db, String(session.recipe_id));
    if (!recipe) {
      throw new ConversationError(404, "recipe not found");
    }
    return recipe;
  }

  /** The session as the operator sees it, with its recipe row. */
  async loadSessionView(session: BuilderSessionRow): Promise<BuilderSessionView> {
    return { ...sessionState(session), recipe: await this.recipeFor(session) };
  }

  toolContext(session: BuilderSessionRow): BuilderToolContext {
    return {
      orgId: session.org_id,
      capabilities: this.deps.capabilities,
      db: connectedDatabase(this.deps.db),
      mcp: this.deps.mcp ?? null,
      recipeId: String(session.recipe_id),
      connection: this.deps.db,
      coachModel: session.config_snapshot.model,
      apply: this.deps.apply,
    };
  }

  async postMessage(
    session: BuilderSessionRow,
    user: UserRow,
    content: string,
  ): Promise<BuilderSessionView> {
    if (!content.trim()) {
      throw new ConversationError(422, "content must not be empty");
    }
    if (session.status !== "active") {
      throw new ConversationConflictError("session cannot generate");
    }
    const started = await withTransaction(this.deps.db, async (client) => {
      const locked = await lockBuilderSession(client, session.id);
      if (!locked) {
        throw new ConversationError(404, "builder session not found");
      }
      if (locked.generation_state !== "idle") {
        throw new ConversationConflictError("builder session is already generating");
      }
      const now = new Date();
      await claimCoachRun(this.policy, client, locked.org_id, now);
      const recipe = await getRecipe(client, String(locked.recipe_id));
      if (!recipe) {
        throw new ConversationError(404, "recipe not found");
      }
      const expectedBodyVersion = recipe.body_version;
      const system = composeBuilderSystemMessage(locked.config_snapshot, recipe, this.deps.guidelinesPath);
      await updateConversationMessage(client, "builder", {
        session_id: locked.id,
        seq: 0,
        payload: { role: "system", content: system.content },
        metadata: { source: "builder_system", system_prompt_hash: system.hash, refreshed: true },
      });
      const generation = locked.generation_number + 1;
      const seq = await nextConversationSeq(client, "builder", locked.id);
      const userMessage = await insertConversationMessage(
        client,
        "builder",
        {
          session_id: locked.id,
          seq,
          generation,
          payload: { role: "user", content },
          metadata: { generation, source: "ui" },
        },
        now,
      );
      const updated = await updateBuilderSession(
        client,
        locked.id,
        {
          generation_state: "generating",
          generation_number: generation,
          generation_token: newId("btg"),
          generation_started_at: now,
        },
        now,
      );
      return {
        session: updated ?? locked,
        generation,
        system,
        recipe: recipe.body,
        expectedBodyVersion,
        userMessage,
      };
    });
    await this.runner.publish(started.session.id, "message.committed", {
      message: started.userMessage,
    });
    const limits = (await this.policy.standing(started.session.org_id)).limits.coach
      .builder;
    const toolContext = this.toolContext(started.session);
    this.runner.start({
      session: started.session,
      user,
      generation: started.generation,
      generationContext: composeBuilderGenerationContext(
        started.recipe,
        started.expectedBodyVersion,
      ),
      systemContent: started.system.content,
      tools: builderConversationTools(toolContext),
      toolContext,
      maxTokens: limits.max_tokens,
      maxSteps: BUILDER_MAX_STEPS,
      maxToolCalls: limits.max_tool_calls,
      maxInput: limits.max_input_tokens,
    });
    return this.loadSessionView(started.session);
  }

  async cancel(session: BuilderSessionRow): Promise<BuilderSessionView> {
    await updateBuilderSession(this.deps.db, session.id, { generation_state: "cancelling" }, new Date());
    this.runner.cancel(session.id);
    return { ...sessionState(session), generation_state: "cancelling", recipe: null };
  }

  /** The session's conversation, in order. */
  messages(session: BuilderSessionRow): Promise<ConversationMessageRow[]> {
    return listConversationMessages(this.deps.db, "builder", session.id);
  }

  /** What Builder sessions spent, per organisation. */
  usageByOrg(): Promise<Map<string, ConversationUsageRow>> {
    return conversationUsageByOrg(this.deps.db, "builder");
  }

  subscribe(sessionId: string): EventQueue<[string, Record<string, unknown>]> {
    return this.runner.subscribe(sessionId);
  }

  unsubscribe(sessionId: string, queue: EventQueue<[string, Record<string, unknown>]>): void {
    this.runner.unsubscribe(sessionId, queue);
  }

  /** Writes the operator's `document` over the session's recipe at `expectedVersion`, under the name and description it gives itself. */
  async writeRecipe(
    session: BuilderSessionRow,
    expectedVersion: number,
    document: RecipeDocument,
  ): Promise<RecipeRow> {
    return writeRecipe(
      this.deps.db,
      { id: session.recipe_id, body_version: expectedVersion },
      { body: document, name: document.meta.name, description: document.meta.description },
      new Date(),
    );
  }

  async reviewField(
    session: BuilderSessionRow,
    path: string,
    review: ReviewAction,
  ): Promise<RecipeRow> {
    return reviewRecipe(this.deps.db, await this.recipeFor(session), path, review);
  }

  async editAccess(session: BuilderSessionRow, edits: AccessEdit[]): Promise<RecipeRow & { access_cuts: AccessCut[] }> {
    const row = await this.recipeFor(session);
    return editRecipeAccess(this.deps.db, row, edits);
  }

  async validate(session: BuilderSessionRow): Promise<RecipeValidation> {
    return validateLibraryRecipe(this.deps.apply, await this.recipeFor(session));
  }

  /** Gives each role a look of the guild's when it has none, then publishes the recipe. */
  async publish(session: BuilderSessionRow): Promise<RecipeRow> {
    const row = await this.recipeFor(session);
    const recipe = row.body;
    let current = row;
    if (assignGuildLooks(recipe.roles)) {
      current = await writeRecipe(this.deps.db, row, { body: recipe }, new Date());
    }
    return publishRecipe(this.deps.apply, current);
  }

  async deploy(
    session: BuilderSessionRow,
    org: OrgMembershipRow,
    user: UserRow,
    choices: ApplyChoices = {},
  ): Promise<RecipeApplyRow> {
    const recipe = await this.recipeFor(session);
    return createSkeleton(this.deps.apply, { org, user, recipeRow: recipe }, choices);
  }
}
