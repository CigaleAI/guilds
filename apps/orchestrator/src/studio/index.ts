import type { ArtifactStore } from "../artifacts/store.js";
import { memoryHistory } from "../memory/history.js";
import { canSeeGuild } from "../guilds/operators.js";
import {
  assertModelConnected,
  coreModelCredentials,
  type ModelCredentialsProvider,
} from "../llm/credentials.js";
import { isMarketplaceModel } from "../llm/providers.js";
import { newId } from "../lib/ids.js";
import type { Scripts } from "../scripts/catalog.js";
import type { Schedules } from "../schedules/service.js";
import { AdmissionCoordinator } from "../admission/coordinator.js";
import { OPEN_POLICY, claimCoachRun, type OrgPolicy } from "../policy/index.js";
import {
  STUDIO_DEFAULT_TEMPERATURE,
  STUDIO_MAX_STEPS,
} from "./constants.js";
import { StudioConflictError, StudioNotFoundError, StudioUnprocessableError } from "./errors.js";
import { StudioDrafts, type DraftPublication } from "./drafts.js";
import { StudioRunner } from "./runner.js";
import { withLockedSession } from "./session-lock.js";
import {
  composeGenerationContext,
  composeStudioSystemMessage,
  hydrateStudioMember,
  readStudioSystemTemplate,
} from "./system.js";
import { refreshSystemMessage } from "./system-message.js";
import { inventoryItem, type StudioInventoryItem } from "./inventory.js";
import { inspectAgent, type StudioInspector } from "./inspector.js";
import { studioToolSchemas } from "./tools.js";
import { previewDatabase, type PreviewDeps } from "./preview.js";
import {
  answerLoginRequest,
  grantSessionConnection,
  grantedConnectionIds,
  withdrawSessionConnection,
  type StudioMcpClient,
} from "./connections.js";
import { resolveStudioFocus, STUDIO_FOCUS_SOURCE, type StudioFocusRequest } from "./focus.js";
import type { ResolvedFocus } from "./focus-evidence.js";
import { isAccessTool } from "./access.js";
import {
  applyEdit,
  editStatus,
  findEditRecord,
  markEdit,
  viewEdit,
  type EditScope,
  type StudioEditView,
} from "./edits.js";
import type { RoutineChange } from "../schedules/operator.js";
import { getGuild, hiddenGuildsFor, type GuildRow } from "../db/guilds.js";
import { findGuildAgent, requireGuildAgent } from "./source-guild.js";
import type { Queryable } from "../db/pg.js";
import {
  type ConversationUsageRow,
  conversationUsageByOrg,
  insertConversationMessage,
  listConversationMessages,
  nextConversationSeq,
} from "../db/conversations.js";
import {
  getStudioDraft,
  getStudioSession,
  insertStudioSession,
  listGeneratingStudioSessions,
  listStudioDraftHeads,
  listStudioSessions,
  markStudioSessionCancelling,
  type StudioDraftRow,
  type StudioSessionRow,
  studioInventory,
  updateStudioSession,
} from "../db/studio.js";
import type { UserRow } from "../db/users.js";
import type { AgentRow } from "../db/agents.js";
import type { OrgMembershipRow } from "../db/orgs.js";
import type { CoachSessionConfig, StudioSourceGuild } from "../db/schema/index.js";
import { loadOperatorActor } from "../artifacts/actors.js";
import { studioActor, type StudioOperator } from "./actor.js";

export type StudioServiceDeps = {
  db: Queryable;
  artifacts: ArtifactStore;
  scripts: Scripts;
  schedules: Schedules;
  notesSystemPath: string;
  mcp?: StudioMcpClient | null;
  admission?: AdmissionCoordinator;
  policy?: OrgPolicy;
  /** What the coach's model provider is called with; core's own rows when absent. */
  credentials?: ModelCredentialsProvider;
  publishFilesChanged?: (guildId: string) => Promise<void>;
  publishRoutinesChanged?: (guildId: string, change: RoutineChange) => Promise<void>;
  isAgentBusy?: (agentId: string) => boolean;
};

/**
 * What the Studio's modules read and write through, built once from the service's own: the stores,
 * the drafts, the projection of an agent's next run, the coach's logins, and the channels a change
 * is announced on.
 */
export type StudioDeps = {
  db: Queryable;
  artifacts: ArtifactStore;
  scripts: Scripts;
  schedules: Schedules;
  notesSystemPath: string;
  mcp: StudioMcpClient | null;
  drafts: StudioDrafts;
  preview: PreviewDeps;
  publishFilesChanged?: ((guildId: string) => Promise<void>) | undefined;
  publishRoutinesChanged?: ((guildId: string, change: RoutineChange) => Promise<void>) | undefined;
  isAgentBusy?: ((agentId: string) => boolean) | undefined;
};

/** A session an operator can still work in: not archived or blocked, its source guild still there. */
export type LiveStudioSession = StudioSessionRow & { source_guild_id: string };

/** The guild as a session records it; its description is the coach's objective. */
function sourceGuildSnapshot(guild: Pick<GuildRow, "id" | "name" | "about" | "description">): StudioSourceGuild {
  const objective = guild.description.trim();
  return { id: guild.id, name: guild.name, about: guild.about, ...(objective ? { objective } : {}) };
}

/**
 * A Studio session as the operator app reads it: where it stands, its guild as the session recorded
 * it, the logins its coach may read through, and its coach's model and limits.
 */
export type StudioSession = Pick<
  StudioSessionRow,
  | "id"
  | "org_id"
  | "mode"
  | "status"
  | "blocked_reason"
  | "generation_state"
  | "generation_number"
  | "source_guild_id"
  | "selected_target_agent_id"
  | "parent_session_id"
  | "created_by_name"
  | "created_at"
  | "updated_at"
  | "archived_at"
> & {
  source_guild: StudioSessionRow["source_guild_snapshot"];
  granted_connection_ids: string[];
  coach: Pick<CoachSessionConfig, "model" | "temperature" | "max_tokens" | "max_steps" | "max_tool_calls" | "max_input_tokens">;
};

/** A published or unchanged draft, with whether its target agent is generating now and so reads the new Task on its next run. */
export type PublishedDraft = DraftPublication & { target_generating: boolean };

/** What an operator opens a Studio session with: its mode, source guild, coach model, and the session it continues. */
export type StudioSessionRequest = {
  mode: string;
  sourceGuildId: string;
  model: string;
  temperature?: number;
  parentSessionId?: string | null;
  summary?: string;
  selectedTargetAgentId?: string | null;
};

export class StudioService {
  deps: StudioDeps;
  runner: StudioRunner;
  admission: AdmissionCoordinator;
  policy: OrgPolicy;
  credentials: ModelCredentialsProvider;

  constructor(services: StudioServiceDeps) {
    this.deps = {
      db: services.db,
      artifacts: services.artifacts,
      scripts: services.scripts,
      schedules: services.schedules,
      notesSystemPath: services.notesSystemPath,
      mcp: services.mcp ?? null,
      drafts: new StudioDrafts(services.db, services.artifacts),
      preview: { db: previewDatabase(services.db), artifacts: services.artifacts, scripts: services.scripts },
      publishFilesChanged: services.publishFilesChanged,
      publishRoutinesChanged: services.publishRoutinesChanged,
      isAgentBusy: services.isAgentBusy,
    };
    this.admission = services.admission ?? new AdmissionCoordinator();
    this.policy = services.policy ?? OPEN_POLICY;
    this.credentials = services.credentials ?? coreModelCredentials(services.db);
    this.runner = new StudioRunner({
      db: services.db,
      admission: this.admission,
      policy: this.policy,
      credentials: this.credentials,
    });
  }

  async reconcile(): Promise<void> {
    for (const row of await listGeneratingStudioSessions(this.deps.db)) {
      await this.runner.reconcile(row);
    }
  }

  async createSession(
    user: UserRow,
    org: OrgMembershipRow,
    request: StudioSessionRequest,
  ): Promise<StudioSession> {
    if (request.mode !== "optimize") {
      throw new StudioUnprocessableError("create mode is not available");
    }
    const guild = await getGuild(this.deps.db, request.sourceGuildId);
    if (
      !guild ||
      guild.org_id !== org.id ||
      !canSeeGuild(guild, user.id)
    ) {
      throw new StudioNotFoundError("guild not found");
    }
    const model = await this.validateModel(org.id, request.model);
    const temperature = this.validateTemperature(request.temperature);
    if (request.parentSessionId) {
      const parent = await getStudioSession(this.deps.db, request.parentSessionId);
      if (
        !parent ||
        parent.org_id !== org.id ||
        parent.created_by_user_id !== user.id
      ) {
        throw new StudioNotFoundError("parent studio session not found");
      }
    }
    const template = readStudioSystemTemplate({ guidelinesPath: this.deps.notesSystemPath });
    const limits = (await this.policy.standing(org.id)).limits.coach.studio;
    const coachConfig = {
      model,
      temperature,
      max_steps: STUDIO_MAX_STEPS,
      ...limits,
    };
    const sourceGuild = sourceGuildSnapshot(guild);
    const members = (await studioInventory(this.deps.db, guild.id, null)).map((row) => hydrateStudioMember(row));
    const system = composeStudioSystemMessage(template, { mode: "optimize", config: coachConfig }, { sourceGuild, members });
    const now = new Date();
    const session = await insertStudioSession(
      this.deps.db,
      {
        id: newId("stu"),
        org_id: org.id,
        created_by_user_id: user.id,
        created_by_name: user.name,
        mode: "optimize",
        source_guild_id: guild.id,
        source_guild_snapshot: sourceGuild,
        config_snapshot: {
          ...coachConfig,
          system_prompt_hash: system.hash,
          tool_schemas: studioToolSchemas(),
        },
        parent_session_id: request.parentSessionId ?? null,
        selected_target_agent_id: request.selectedTargetAgentId ?? null,
        status: "active",
      },
      now,
    );
    await insertConversationMessage(
      this.deps.db,
      "studio",
      {
        session_id: session.id,
        seq: 0,
        generation: 0,
        payload: { role: "system", content: system.content },
        metadata: { source: "studio_system", system_prompt_hash: system.hash },
      },
      now,
    );
    if (request.summary) {
      await insertConversationMessage(
        this.deps.db,
        "studio",
        {
          session_id: session.id,
          seq: 1,
          generation: 0,
          payload: { role: "user", content: request.summary },
          metadata: { source: "continuation" },
        },
        now,
      );
    }
    return this.viewSession(session);
  }

  /** The coach's model: a marketplace model whose provider the organisation has connected. */
  async validateModel(orgId: string, model: string): Promise<string> {
    const id = model.trim();
    if (!id) {
      throw new StudioUnprocessableError("model is required");
    }
    if (!isMarketplaceModel(id)) {
      throw new StudioUnprocessableError("the coach needs a marketplace model");
    }
    await assertModelConnected(this.credentials, orgId, id);
    return id;
  }

  validateTemperature(value: number | undefined): number {
    const n = value ?? STUDIO_DEFAULT_TEMPERATURE;
    if (!Number.isFinite(n) || n < 0 || n > 2) {
      throw new StudioUnprocessableError("temperature must be between 0 and 2");
    }
    return n;
  }

  async listSessions(orgId: string, userId: string): Promise<StudioSession[]> {
    const rows = await listStudioSessions(this.deps.db, orgId, userId);
    const hidden = new Set<string>();
    for (const guildId of new Set(rows.flatMap((row) => (row.source_guild_id ? [row.source_guild_id] : [])))) {
      const guild = await getGuild(this.deps.db, guildId);
      if (guild && !canSeeGuild(guild, userId)) hidden.add(guildId);
    }
    return rows
      .filter((row) => !hidden.has(row.source_guild_id ?? ""))
      .map((row) => this.viewSession(row));
  }

  async getOwnedSession(sessionId: string, user: UserRow, org: OrgMembershipRow): Promise<StudioSessionRow> {
    const session = await getStudioSession(this.deps.db, sessionId);
    if (!session || session.org_id !== org.id) {
      throw new StudioNotFoundError("studio session not found");
    }
    if (session.created_by_user_id && session.created_by_user_id !== user.id) {
      throw new StudioNotFoundError("studio session not found");
    }
    if (!session.created_by_user_id) {
      throw new StudioNotFoundError("studio session not found");
    }
    // Seeing the guild is checked on every request, not only at creation: a
    // user who can no longer see a private guild loses its sessions too.
    if (session.source_guild_id) {
      const guild = await getGuild(this.deps.db, session.source_guild_id);
      if (guild && !canSeeGuild(guild, user.id)) {
        throw new StudioNotFoundError("studio session not found");
      }
    }
    if (!session.source_guild_id && session.status === "active") {
      await updateStudioSession(this.deps.db, sessionId, { status: "blocked", blocked_reason: "source_deleted" }, new Date());
      session.status = "blocked";
      session.blocked_reason = "source_deleted";
    }
    return session;
  }

  viewSession(row: StudioSessionRow): StudioSession {
    const config = row.config_snapshot;
    return {
      id: row.id,
      org_id: row.org_id,
      mode: row.mode,
      status: row.status,
      blocked_reason: row.blocked_reason,
      generation_state: row.generation_state,
      generation_number: row.generation_number,
      source_guild_id: row.source_guild_id,
      source_guild: row.source_guild_snapshot,
      selected_target_agent_id: row.selected_target_agent_id,
      parent_session_id: row.parent_session_id,
      granted_connection_ids: grantedConnectionIds(row),
      coach: {
        model: config.model,
        temperature: config.temperature,
        max_tokens: config.max_tokens,
        max_steps: config.max_steps,
        max_tool_calls: config.max_tool_calls,
        max_input_tokens: config.max_input_tokens,
      },
      created_by_name: row.created_by_name,
      created_at: row.created_at,
      updated_at: row.updated_at,
      archived_at: row.archived_at,
    };
  }

  /** Lets the coach use one login of the source guild in this session. */
  async grantConnection(
    session: StudioSessionRow,
    connectionId: string,
  ): Promise<StudioSession> {
    return this.viewSession(await grantSessionConnection(this.deps.db, session, connectionId));
  }

  /** Takes one login back from the coach in this session. */
  async withdrawConnection(
    session: StudioSessionRow,
    connectionId: string,
  ): Promise<StudioSession> {
    return this.viewSession(await withdrawSessionConnection(this.deps.db, session, connectionId));
  }

  // Grant or decline one login request from the Studio log. The answer and
  // who gave it are kept on the request's tool message; a grant also adds the
  // login to the session. The session lock serialises answers.
  async resolveLogin(
    session: StudioSessionRow,
    user: UserRow,
    seq: number,
    decision: "grant" | "decline",
  ): Promise<StudioSession> {
    this.assertLive(session);
    return this.viewSession(await answerLoginRequest(this.deps.db, session, { user, seq, decision }));
  }

  async archive(session: StudioSessionRow): Promise<StudioSession> {
    if (session.generation_state === "generating") {
      throw new StudioConflictError("cannot archive while generating");
    }
    const now = new Date();
    const updated = await updateStudioSession(
      this.deps.db,
      session.id,
      { status: "archived", archived_at: now, generation_state: "idle" },
      now,
    );
    return this.viewSession(updated ?? session);
  }

  async setTarget(session: StudioSessionRow, agentId: string | null): Promise<StudioSession> {
    return withLockedSession(this.deps.db, session.id, async (client, locked) => {
      if (locked.status !== "active") {
        throw new StudioConflictError("session cannot change inspector");
      }
      if (
        agentId &&
        (!locked.source_guild_id || !(await findGuildAgent(this.deps.db, locked.source_guild_id, locked.org_id, agentId)))
      ) {
        throw new StudioUnprocessableError("agent is not in the source guild");
      }
      const updated = await updateStudioSession(
        client,
        locked.id,
        { selected_target_agent_id: agentId },
        new Date(),
      );
      return this.viewSession(updated ?? locked);
    });
  }

  async inventory(session: StudioSessionRow): Promise<StudioInventoryItem[]> {
    this.assertLive(session);
    const rows = await studioInventory(this.deps.db, session.source_guild_id, session.id);
    return rows.map((row) => inventoryItem(row));
  }

  /** One agent of the session's guild as the inspector shows it to `user`, without what is hidden from them. */
  async inspector(session: StudioSessionRow, user: UserRow, agentId: string): Promise<StudioInspector> {
    this.assertLive(session);
    const agent = await this.requireGuildAgent(session, agentId);
    const viewer = studioActor({
      orgId: session.org_id,
      sourceGuildId: agent.guild_id,
      user,
      hidden: await hiddenGuildsFor(this.deps.db, session.org_id, user.id),
    });
    return inspectAgent(this.deps, viewer, agent);
  }

  async memoryTimeline(
    session: StudioSessionRow,
    user: UserRow,
    agentId: string,
  ): ReturnType<typeof memoryHistory> {
    this.assertLive(session);
    const agent = await this.requireGuildAgent(session, agentId);
    const actor = await loadOperatorActor(this.deps.db, user, {
      orgId: session.org_id,
      guildId: session.source_guild_id,
      agentId,
    });
    return memoryHistory(this.deps, actor, { id: agent.id, name: agent.name });
  }

  async postMessage(
    session: StudioSessionRow,
    user: UserRow,
    content: string,
    focusInput?: StudioFocusRequest | null,
  ): Promise<StudioSession> {
    this.assertLive(session);
    if (!content.trim()) {
      throw new StudioUnprocessableError("content must not be empty");
    }
    // The pin and every tool call of the generation read as the user, without the private guilds
    // hidden from them as it starts.
    const operator: StudioOperator = {
      orgId: session.org_id,
      sourceGuildId: session.source_guild_id,
      user,
      hidden: await hiddenGuildsFor(this.deps.db, session.org_id, user.id),
    };
    // Resolve the pin before taking the lock: it reads guild data only.
    const focus: ResolvedFocus | null =
      focusInput === undefined || focusInput === null
        ? null
        : await resolveStudioFocus({ db: this.deps.db, artifacts: this.deps.artifacts }, operator, focusInput, new Date());
    const started = await withLockedSession(this.deps.db, session.id, async (client, locked) => {
      if (locked.status !== "active") {
        throw new StudioConflictError("session cannot generate");
      }
      if (locked.generation_state !== "idle") {
        throw new StudioConflictError("studio session is already generating");
      }
      const now = new Date();
      await claimCoachRun(this.policy, client, locked.org_id, now);
      const rows = await studioInventory(this.deps.db, session.source_guild_id, locked.id);
      const systemContent = await refreshSystemMessage(this.deps, locked, rows, client);
      const generation = locked.generation_number + 1;
      let seq = await nextConversationSeq(client, "studio", locked.id);
      if (focus) {
        // A stored user row, so the pin stays in the projected history of
        // every later turn of this session.
        await insertConversationMessage(
          client,
          "studio",
          {
            session_id: locked.id,
            seq,
            generation,
            payload: { role: "user", content: focus.content },
            metadata: { generation, source: STUDIO_FOCUS_SOURCE, focus: focus.focus },
          },
          now,
        );
        seq += 1;
      }
      await insertConversationMessage(
        client,
        "studio",
        {
          session_id: locked.id,
          seq,
          generation,
          payload: { role: "user", content },
          metadata: { generation, source: "ui" },
        },
        now,
      );
      const token = newId("stg");
      const updated = await updateStudioSession(
        client,
        locked.id,
        {
          generation_state: "generating",
          generation_number: generation,
          generation_token: token,
          generation_started_at: now,
        },
        now,
      );
      return { session: updated ?? locked, generation, systemContent, rows };
    });
    const drafts = await listStudioDraftHeads(this.deps.db, started.session.id);
    const generationContext = composeGenerationContext(
      session.source_guild_id,
      started.rows.map((row) => inventoryItem(row)),
      drafts[0] ?? null,
    );
    const limits = (await this.policy.standing(started.session.org_id)).limits.coach.studio;
    this.runner.start(
      this.deps,
      {
        session: {
          ...started.session,
          config_snapshot: { ...started.session.config_snapshot, ...limits },
        },
        generation: started.generation,
        generationContext,
        systemContent: started.systemContent,
      },
      { ...operator, session: started.session },
    );
    return this.viewSession(started.session);
  }

  /** The draft and its session when the draft belongs to the organisation, otherwise null. */
  async orgDraft(
    orgId: string,
    draftId: string,
  ): Promise<{ draft: StudioDraftRow; session: StudioSessionRow | null } | null> {
    const draft = await getStudioDraft(this.deps.db, draftId);
    if (!draft || draft.org_id !== orgId) {
      return null;
    }
    return { draft, session: await getStudioSession(this.deps.db, draft.session_id) };
  }

  /** What Studio sessions spent, per organisation. */
  usageByOrg(): Promise<Map<string, ConversationUsageRow>> {
    return conversationUsageByOrg(this.deps.db, "studio");
  }

  /** Stops the generation running on the session; a session no generation runs on is returned as it is. */
  async cancel(session: StudioSessionRow): Promise<StudioSession> {
    const cancelling = await markStudioSessionCancelling(this.deps.db, session.id, new Date());
    if (cancelling === null) {
      return this.viewSession(session);
    }
    this.runner.cancel(session.id);
    return this.viewSession(cancelling);
  }

  async continueSession(
    session: StudioSessionRow,
    user: UserRow,
    org: OrgMembershipRow,
  ): Promise<StudioSession> {
    if (session.status !== "blocked" || session.blocked_reason !== "input_token_limit") {
      throw new StudioUnprocessableError("session is not blocked on input tokens");
    }
    if (!session.source_guild_id) {
      throw new StudioUnprocessableError("source guild is gone");
    }
    const config = session.config_snapshot;
    const heads = await listStudioDraftHeads(this.deps.db, session.id);
    const summary = `Continue from Studio session ${session.id}. Active draft heads: ${heads.map((row) => row.id).join(", ") || "none"}.`;
    return this.createSession(user, org, {
      mode: "optimize",
      sourceGuildId: session.source_guild_id,
      model: config.model,
      temperature: config.temperature,
      parentSessionId: session.id,
      summary,
      selectedTargetAgentId: session.selected_target_agent_id,
    });
  }

  /** Publishes a draft of the session to its target agent's task, as `user`. */
  async publishDraft(
    session: StudioSessionRow,
    user: UserRow,
    draftId: string,
  ): Promise<PublishedDraft> {
    const result = await this.deps.drafts.publish(this.deps, session, user, draftId);
    return this.announcePublish(session, result);
  }

  // Tells the source guild its files changed when the draft was published,
  // and adds whether the target agent is generating to the outcome.
  private async announcePublish(session: StudioSessionRow, result: DraftPublication): Promise<PublishedDraft> {
    if (result.outcome === "published" && this.deps.publishFilesChanged && session.source_guild_id) {
      await this.deps.publishFilesChanged(session.source_guild_id);
    }
    const targetId = result.draft.target_agent_id;
    return {
      ...result,
      target_generating: targetId ? Boolean(this.deps.isAgentBusy?.(targetId)) : false,
    };
  }

  private async editScope(session: LiveStudioSession, user: UserRow): Promise<EditScope> {
    return {
      orgId: session.org_id,
      sourceGuildId: session.source_guild_id,
      sessionId: session.id,
      user,
      hidden: await hiddenGuildsFor(this.deps.db, session.org_id, user.id),
    };
  }

  async getEdit(
    session: StudioSessionRow,
    user: UserRow,
    seq: number,
  ): Promise<StudioEditView> {
    const sourceGuildId = session.source_guild_id;
    if (!sourceGuildId) {
      throw new StudioUnprocessableError("source guild is gone");
    }
    const record = findEditRecord(await listConversationMessages(this.deps.db, "studio", session.id), seq);
    const scope = await this.editScope({ ...session, source_guild_id: sourceGuildId }, user);
    return viewEdit(this.deps, scope, record);
  }

  // Apply or decline one edit request from the Studio log. The session lock
  // serialises answers, so a request resolves once.
  async resolveEdit(
    session: StudioSessionRow,
    user: UserRow,
    seq: number,
    decision: "apply" | "decline",
  ): Promise<StudioEditView> {
    this.assertLive(session);
    const deps = this.deps;
    const scope = await this.editScope(session, user);
    const userId = user.id;
    const outcome = await withLockedSession(this.deps.db, session.id, async () => {
      const record = findEditRecord(await listConversationMessages(this.deps.db, "studio", session.id), seq);
      if (editStatus(record) !== "pending") {
        throw new StudioConflictError(`edit request is already ${editStatus(record)}`);
      }
      if (decision === "decline") {
        await markEdit(this.deps.db, session.id, record, { status: "declined", version: null, userId });
        return { record, applied: null };
      }
      const applied = await applyEdit(deps, scope, record);
      await markEdit(this.deps.db, session.id, record, {
        status: "applied",
        version: applied.version,
        userId,
      });
      return { record, applied };
    });
    if (outcome.applied?.guild) {
      await updateStudioSession(
        this.deps.db,
        session.id,
        { source_guild_snapshot: sourceGuildSnapshot(outcome.applied.guild) },
        new Date(),
      );
    } else if (outcome.applied?.routine) {
      await this.deps.publishRoutinesChanged?.(session.source_guild_id, outcome.applied.routine);
    } else if (outcome.applied && !isAccessTool(outcome.record.toolName) && this.deps.publishFilesChanged) {
      await this.deps.publishFilesChanged(session.source_guild_id);
    }
    const record = findEditRecord(await listConversationMessages(this.deps.db, "studio", session.id), seq);
    return viewEdit(deps, scope, record);
  }

  assertLive(session: StudioSessionRow): asserts session is LiveStudioSession {
    if (session.status === "archived") {
      throw new StudioConflictError("session is archived");
    }
    if (!session.source_guild_id || session.status === "blocked") {
      throw new StudioConflictError("session source is not live");
    }
  }

  /** The agent `agentId` names in the session's source guild; StudioNotFoundError when it names none there. */
  async requireGuildAgent(session: LiveStudioSession, agentId: string): Promise<AgentRow> {
    return requireGuildAgent(this.deps.db, session.source_guild_id, session.org_id, agentId);
  }
}
