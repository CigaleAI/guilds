import { createHash } from "node:crypto";
import type { ArtifactStore } from "../artifacts/store.js";
import { memoryHistory } from "../memory/history.js";
import { canSeeGuild } from "../guilds/operators.js";
import {
  assertModelConnected,
  coreModelCredentials,
  type ModelCredentialsProvider,
  ModelNotConnectedError,
} from "../llm/credentials.js";
import { isMarketplaceModel } from "../llm/providers.js";
import { newId } from "../lib/ids.js";
import { EventQueue } from "../lib/event.js";
import type { Scripts } from "../scripts/catalog.js";
import type { Schedules } from "../schedules/service.js";
import { AdmissionCoordinator } from "../admission/coordinator.js";
import { OPEN_POLICY, claimCoachRun, type OrgPolicy } from "../policy/index.js";
import {
  STUDIO_DEFAULT_TEMPERATURE,
  STUDIO_MAX_STEPS,
} from "./constants.js";
import { StudioConflictError, StudioError, StudioUnprocessableError } from "./errors.js";
import { StudioDrafts, viewDraft } from "./drafts.js";
import { StudioRunner } from "./runner.js";
import { withLockedSession } from "./session-lock.js";
import {
  composeGenerationContext,
  composeStudioSystemMessage,
  hydrateStudioMember,
  readStudioSystemTemplate,
  studioSystemHash,
} from "./system.js";
import { refreshSystemMessage } from "./system-message.js";
import { inventoryItem, type StudioInventoryItem } from "./inventory.js";
import { inspectAgent } from "./inspector.js";
import { studioToolSchemas, type StudioToolDeps } from "./tools.js";
import { previewDatabase, type PreviewDeps } from "./preview.js";
import {
  answerLoginRequest,
  grantSessionConnection,
  grantedConnectionIds,
  listSessionConnections,
  withdrawSessionConnection,
  type StudioMcpClient,
} from "./connections.js";
import type { StudioFocus } from "../db/schema/index.js";
import { resolveStudioFocus, STUDIO_FOCUS_SOURCE, type StudioFocusRequest } from "./focus.js";
import { isAccessTool } from "./access.js";
import {
  applyEdit,
  editStatus,
  findEditRecord,
  markEdit,
  viewEdit,
  type EditDeps,
  type EditScope,
} from "./edits.js";
import type { RoutineChange } from "./routines.js";
import { getGuild, type GuildRow } from "../db/guilds.js";
import { getAgent } from "../db/agents.js";
import type { Queryable } from "../db/pg.js";
import {
  type ConversationMessageRow,
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
  listOrphanStudioDrafts,
  listStudioDraftHeads,
  listStudioDrafts,
  listStudioSessions,
  type StudioDraftRow,
  type StudioInventoryRow,
  type StudioSessionRow,
  studioInventory,
  updateStudioSession,
} from "../db/studio.js";
import type { UserRow } from "../db/users.js";
import type { AgentRow } from "../db/agents.js";
import type { OrgMembershipRow } from "../db/orgs.js";
import type { StudioSourceGuild } from "../db/schema/index.js";
import { operatorActor } from "../artifacts/actors.js";

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

/** A session an operator can still work in: not archived or blocked, its source guild still there. */
export type LiveStudioSession = StudioSessionRow & { source_guild_id: string };

/** The guild as a session records it; its description is the coach's objective. */
function sourceGuildSnapshot(guild: Pick<GuildRow, "id" | "name" | "about" | "description">): StudioSourceGuild {
  const objective = guild.description.trim();
  return { id: guild.id, name: guild.name, about: guild.about, ...(objective ? { objective } : {}) };
}

export class StudioService {
  drafts: StudioDrafts;
  runner: StudioRunner;
  admission: AdmissionCoordinator;
  policy: OrgPolicy;
  credentials: ModelCredentialsProvider;

  constructor(public deps: StudioServiceDeps) {
    this.drafts = new StudioDrafts(deps.db, deps.artifacts);
    this.admission = deps.admission ?? new AdmissionCoordinator();
    this.policy = deps.policy ?? OPEN_POLICY;
    this.credentials = deps.credentials ?? coreModelCredentials(deps.db);
    this.runner = new StudioRunner({
      db: deps.db,
      admission: this.admission,
      policy: this.policy,
      credentials: this.credentials,
    });
  }

  previewDeps(): PreviewDeps {
    return {
      db: previewDatabase(this.deps.db),
      artifacts: this.deps.artifacts,
      scripts: this.deps.scripts,
    };
  }

  async reconcile(): Promise<void> {
    for (const row of await listGeneratingStudioSessions(this.deps.db)) {
      await this.runner.reconcile(row);
    }
  }

  async createSession(args: {
    user: UserRow;
    org: OrgMembershipRow;
    mode: string;
    sourceGuildId: string;
    model: string;
    temperature?: number;
    parentSessionId?: string | null;
    summary?: string;
    selectedTargetAgentId?: string | null;
  }): Promise<Record<string, unknown>> {
    if (args.mode !== "optimize") {
      throw new StudioUnprocessableError("create mode is not available");
    }
    const guild = await getGuild(this.deps.db, args.sourceGuildId);
    if (
      !guild ||
      String(guild.org_id) !== String(args.org.id) ||
      !canSeeGuild(guild, String(args.user.id))
    ) {
      throw new StudioError(404, "guild not found");
    }
    const model = await this.validateModel(String(args.org.id), args.model);
    const temperature = this.validateTemperature(args.temperature);
    if (args.parentSessionId) {
      const parent = await getStudioSession(this.deps.db, args.parentSessionId);
      if (
        !parent ||
        String(parent.org_id) !== String(args.org.id) ||
        String(parent.created_by_user_id ?? "") !== String(args.user.id)
      ) {
        throw new StudioError(404, "parent studio session not found");
      }
    }
    const template = readStudioSystemTemplate({ guidelinesPath: this.deps.notesSystemPath });
    const limits = (await this.policy.standing(String(args.org.id))).limits.coach.studio;
    const coachConfig = {
      model,
      temperature,
      max_steps: STUDIO_MAX_STEPS,
      ...limits,
    };
    const sourceGuild = sourceGuildSnapshot(guild);
    const members = (await studioInventory(this.deps.db, guild.id, null)).map((row) => hydrateStudioMember(row));
    const system = composeStudioSystemMessage({
      mode: "optimize",
      sourceGuild,
      members,
      config: coachConfig,
      template,
    });
    const now = new Date();
    const session = await insertStudioSession(
      this.deps.db,
      {
        id: newId("stu"),
        org_id: String(args.org.id),
        created_by_user_id: String(args.user.id),
        created_by_name: typeof args.user.name === "string" ? args.user.name : "operator",
        mode: "optimize",
        source_guild_id: guild.id,
        source_guild_snapshot: sourceGuild,
        config_snapshot: {
          ...coachConfig,
          system_prompt_hash: system.hash,
          tool_schemas: studioToolSchemas(),
        },
        parent_session_id: args.parentSessionId ?? null,
        selected_target_agent_id: args.selectedTargetAgentId ?? null,
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
    if (args.summary) {
      await insertConversationMessage(
        this.deps.db,
        "studio",
        {
          session_id: session.id,
          seq: 1,
          generation: 0,
          payload: { role: "user", content: args.summary },
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
    try {
      await assertModelConnected(this.credentials, orgId, id);
    } catch (error) {
      if (error instanceof ModelNotConnectedError) {
        throw new StudioUnprocessableError(error.message);
      }
      throw error;
    }
    return id;
  }

  validateTemperature(value: unknown): number {
    const n = value === undefined || value === null ? STUDIO_DEFAULT_TEMPERATURE : Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 2) {
      throw new StudioUnprocessableError("temperature must be between 0 and 2");
    }
    return n;
  }

  async listSessions(orgId: string, userId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await listStudioSessions(this.deps.db, orgId, userId);
    const hidden = new Set<string>();
    for (const guildId of new Set(rows.map((row) => String(row.source_guild_id ?? "")).filter(Boolean))) {
      const guild = await getGuild(this.deps.db, guildId);
      if (guild && !canSeeGuild(guild, userId)) hidden.add(guildId);
    }
    return rows
      .filter((row) => !hidden.has(String(row.source_guild_id ?? "")))
      .map((row) => this.viewSession(row));
  }

  async getOwnedSession(sessionId: string, user: UserRow, org: OrgMembershipRow): Promise<StudioSessionRow> {
    const session = await getStudioSession(this.deps.db, sessionId);
    if (!session || session.org_id !== org.id) {
      throw new StudioError(404, "studio session not found");
    }
    if (session.created_by_user_id && session.created_by_user_id !== user.id) {
      throw new StudioError(404, "studio session not found");
    }
    if (!session.created_by_user_id) {
      throw new StudioError(404, "studio session not found");
    }
    // Seeing the guild is checked on every request, not only at creation: a
    // user who can no longer see a private guild loses its sessions too.
    if (session.source_guild_id) {
      const guild = await getGuild(this.deps.db, session.source_guild_id);
      if (guild && !canSeeGuild(guild, user.id)) {
        throw new StudioError(404, "studio session not found");
      }
    }
    if (!session.source_guild_id && session.status === "active") {
      await updateStudioSession(this.deps.db, sessionId, { status: "blocked", blocked_reason: "source_deleted" }, new Date());
      session.status = "blocked";
      session.blocked_reason = "source_deleted";
    }
    return session;
  }

  viewSession(row: StudioSessionRow): Record<string, unknown> {
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

  async listConnections(session: StudioSessionRow): Promise<Array<Record<string, unknown>>> {
    return listSessionConnections(this.previewDeps(), session);
  }

  /** Lets the coach use one login of the source guild in this session. */
  async grantConnection(
    session: StudioSessionRow,
    connectionId: string,
  ): Promise<Record<string, unknown>> {
    return this.viewSession(await grantSessionConnection(this.deps.db, session, connectionId));
  }

  /** Takes one login back from the coach in this session. */
  async withdrawConnection(
    session: StudioSessionRow,
    connectionId: string,
  ): Promise<Record<string, unknown>> {
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
  ): Promise<Record<string, unknown>> {
    this.assertLive(session);
    return this.viewSession(await answerLoginRequest(this.deps.db, session, { user, seq, decision }));
  }

  async archive(session: StudioSessionRow): Promise<Record<string, unknown>> {
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

  async setTarget(session: StudioSessionRow, agentId: string | null): Promise<Record<string, unknown>> {
    return withLockedSession(this.deps.db, session.id, async (client, locked) => {
      if (locked.status !== "active") {
        throw new StudioConflictError("session cannot change inspector");
      }
      if (agentId) {
        const agent = await getAgent(this.deps.db, agentId);
        if (!agent || agent.guild_id !== locked.source_guild_id) {
          throw new StudioUnprocessableError("agent is not in the source guild");
        }
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

  async inventory(session: StudioSessionRow): Promise<Array<Record<string, unknown>>> {
    this.assertLive(session);
    const rows = await studioInventory(this.deps.db, session.source_guild_id, session.id);
    return rows.map((row) => inventoryItem(row));
  }

  inventoryItem(row: StudioInventoryRow): StudioInventoryItem {
    return inventoryItem(row);
  }

  async inspector(session: StudioSessionRow, agentId: string): Promise<Record<string, unknown>> {
    this.assertLive(session);
    const agent = await this.requireGuildAgent(session, agentId);
    return inspectAgent(
      {
        db: this.deps.db,
        artifacts: this.deps.artifacts,
        preview: this.previewDeps(),
        notesSystemPath: this.deps.notesSystemPath,
        isAgentBusy: this.deps.isAgentBusy,
      },
      agent,
    );
  }

  async memoryTimeline(
    session: StudioSessionRow,
    user: UserRow,
    agentId: string,
  ): Promise<Record<string, unknown>> {
    this.assertLive(session);
    const agent = await this.requireGuildAgent(session, agentId);
    const actor = operatorActor({
      orgId: session.org_id,
      actorId: user.id,
      actorName: user.name,
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
  ): Promise<Record<string, unknown>> {
    this.assertLive(session);
    if (!content.trim()) {
      throw new StudioUnprocessableError("content must not be empty");
    }
    // Resolve the pin before taking the lock: it reads guild data only.
    const focus: { focus: StudioFocus; content: string } | null =
      focusInput === undefined || focusInput === null
        ? null
        : await resolveStudioFocus(
            {
              db: this.deps.db,
              artifacts: this.deps.artifacts,
              orgId: session.org_id,
              sourceGuildId: session.source_guild_id,
              user,
            },
            focusInput,
          );
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
      const generation = Number(locked.generation_number) + 1;
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
    const generationContext = composeGenerationContext({
      sourceGuild: { id: session.source_guild_id },
      roster: started.rows.map((row) => inventoryItem(row)),
      draft: drafts[0] ?? null,
    });
    const limits = (await this.policy.standing(started.session.org_id)).limits.coach.studio;
    this.runner.start({
      session: {
        ...started.session,
        config_snapshot: { ...started.session.config_snapshot, ...limits },
      },
      user,
      generation: started.generation,
      generationContext,
      systemContent: started.systemContent,
      toolDeps: this.toolDeps(),
      toolCall: {
        session: started.session,
        user,
        orgId: started.session.org_id,
        sourceGuildId: session.source_guild_id,
      },
    });
    return this.viewSession(started.session);
  }

  /** The guild's agents as the coach sees them, outside any session. */
  guildInventory(guildId: string): Promise<StudioInventoryRow[]> {
    return studioInventory(this.deps.db, guildId, null);
  }

  /** The session's conversation, in order. */
  messages(session: StudioSessionRow): Promise<ConversationMessageRow[]> {
    return listConversationMessages(this.deps.db, "studio", session.id);
  }

  /** Every draft of the session, newest first. */
  sessionDrafts(session: StudioSessionRow): Promise<StudioDraftRow[]> {
    return listStudioDrafts(this.deps.db, session.id);
  }

  /** The organisation's open drafts whose session's user is gone. */
  orphanDrafts(orgId: string): Promise<StudioDraftRow[]> {
    return listOrphanStudioDrafts(this.deps.db, orgId);
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

  async cancel(session: StudioSessionRow): Promise<Record<string, unknown>> {
    await updateStudioSession(this.deps.db, session.id, { generation_state: "cancelling" }, new Date());
    this.runner.cancel(session.id);
    return this.viewSession({ ...session, generation_state: "cancelling" });
  }

  subscribe(sessionId: string): EventQueue<[string, Record<string, unknown>]> {
    return this.runner.subscribe(sessionId);
  }

  unsubscribe(sessionId: string, queue: EventQueue<[string, Record<string, unknown>]>): void {
    this.runner.unsubscribe(sessionId, queue);
  }

  async continueSession(
    session: StudioSessionRow,
    user: UserRow,
    org: OrgMembershipRow,
  ): Promise<Record<string, unknown>> {
    if (session.blocked_reason !== "input_token_limit" && session.status !== "blocked") {
      throw new StudioUnprocessableError("session is not blocked on input tokens");
    }
    if (!session.source_guild_id) {
      throw new StudioUnprocessableError("source guild is gone");
    }
    const config = session.config_snapshot;
    const heads = await listStudioDraftHeads(this.deps.db, session.id);
    const summary = `Continue from Studio session ${session.id}. Active draft heads: ${heads.map((row) => row.id).join(", ") || "none"}.`;
    return this.createSession({
      user,
      org,
      mode: "optimize",
      sourceGuildId: session.source_guild_id,
      model: config.model,
      temperature: config.temperature,
      parentSessionId: session.id,
      summary,
      selectedTargetAgentId: session.selected_target_agent_id ? String(session.selected_target_agent_id) : null,
    });
  }

  /** Publishes a draft of the session to its target agent's task. */
  async publishDraft(
    session: StudioSessionRow,
    user: UserRow,
    draftId: string,
  ): Promise<Record<string, unknown>> {
    const result = await this.drafts.publish({
      session,
      user,
      draftId,
      db: this.deps.db,
      preview: this.previewDeps(),
      notesSystemPath: this.deps.notesSystemPath,
    });
    return this.announcePublish(session, result);
  }

  /** Publishes a draft of a session whose operator is gone, for an organisation manager. */
  async publishOrphanDraft(
    session: StudioSessionRow,
    user: UserRow,
    draftId: string,
  ): Promise<Record<string, unknown>> {
    const result = await this.drafts.publish({
      session,
      user,
      draftId,
      db: this.deps.db,
      preview: this.previewDeps(),
      notesSystemPath: this.deps.notesSystemPath,
      orphan: true,
    });
    return this.announcePublish(session, result);
  }

  // Tells the source guild its files changed when the draft was published,
  // and adds whether the target agent is generating to the outcome.
  private async announcePublish(
    session: StudioSessionRow,
    result: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (result.outcome === "published" && this.deps.publishFilesChanged && session.source_guild_id) {
      await this.deps.publishFilesChanged(session.source_guild_id);
    }
    const targetId = String((result.draft as { target_agent_id?: string } | undefined)?.target_agent_id ?? "");
    return {
      ...result,
      target_generating: targetId ? Boolean(this.deps.isAgentBusy?.(targetId)) : false,
    };
  }

  private toolDeps(): StudioToolDeps {
    return {
      artifacts: this.deps.artifacts,
      db: this.deps.db,
      schedules: this.deps.schedules,
      drafts: this.drafts,
      preview: this.previewDeps(),
      notesSystemPath: this.deps.notesSystemPath,
      mcp: this.deps.mcp ?? null,
    };
  }

  private editDeps(): EditDeps {
    return { db: this.deps.db, artifacts: this.deps.artifacts, schedules: this.deps.schedules };
  }

  private editScope(session: LiveStudioSession, user: UserRow): EditScope {
    return {
      orgId: session.org_id,
      sourceGuildId: session.source_guild_id,
      sessionId: session.id,
      user,
    };
  }

  async getEdit(
    session: StudioSessionRow,
    user: UserRow,
    seq: number,
  ): Promise<Record<string, unknown>> {
    const sourceGuildId = session.source_guild_id;
    if (!sourceGuildId) {
      throw new StudioUnprocessableError("source guild is gone");
    }
    const record = findEditRecord(await listConversationMessages(this.deps.db, "studio", session.id), seq);
    const scope = this.editScope({ ...session, source_guild_id: sourceGuildId }, user);
    return viewEdit(this.editDeps(), scope, record);
  }

  // Apply or decline one edit request from the Studio log. The session lock
  // serialises answers, so a request resolves once.
  async resolveEdit(
    session: StudioSessionRow,
    user: UserRow,
    seq: number,
    decision: "apply" | "decline",
  ): Promise<Record<string, unknown>> {
    this.assertLive(session);
    const deps = this.editDeps();
    const scope = this.editScope(session, user);
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

  async requireGuildAgent(session: StudioSessionRow, agentId: string): Promise<AgentRow> {
    const agent = await getAgent(this.deps.db, agentId);
    if (!agent || agent.guild_id !== session.source_guild_id) {
      throw new StudioError(404, "agent not found");
    }
    return agent;
  }
}

export { viewDraft, studioSystemHash, createHash };
