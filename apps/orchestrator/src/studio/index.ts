import { createHash } from "node:crypto";
import type { ArtifactStore } from "../artifacts/index.js";
import {
  collectTaskEmbeds,
  displayPathFor,
  hashArtifactContent,
  inlineTaskEmbeds,
  taskEmbedActor,
} from "../artifacts/index.js";
import { memoryHistory } from "../memory/history.js";
import { canSeeGuild } from "../guilds/validation.js";
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
import { memoryOf } from "../agents/validation.js";
import { composeAgentSystemPrompt, hydrateStanding, promptHash, schemasOffer } from "../prompts/index.js";
import { jsonObj } from "../db/json.js";
import { iso } from "../db/views.js";
import type { Scripts } from "../scripts/catalog.js";
import type { Schedules } from "../schedules/service.js";
import { AdmissionCoordinator } from "../generation/admission.js";
import { OPEN_POLICY, claimCoachRun, coachRunClaims, type OrgPolicy } from "../policy/index.js";
import {
  STUDIO_DEFAULT_TEMPERATURE,
  STUDIO_MAX_STEPS,
} from "./constants.js";
import { StudioConflictError, StudioError, StudioUnprocessableError } from "./errors.js";
import { StudioDrafts, viewDraft } from "./drafts.js";
import { StudioRunner } from "./runner.js";
import { withLockedSession } from "./session-lock.js";
import { composeGenerationContext, composeStudioSystemMessage, hydrateStudioMember, readStudioSystemTemplate, studioSystemHash } from "./system.js";
import { studioToolSchemas } from "./tools.js";
import {
  previewCurrentState,
  previewDatabase,
  projectGuildConnections,
  projectOfferedToolSchemas,
  type PreviewDeps,
} from "./preview.js";
import {
  findLoginRecord,
  grantedConnectionIds,
  loginStatus,
  reachableConnection,
  type StudioMcpClient,
} from "./connections.js";
import { resolveStudioFocus, STUDIO_FOCUS_SOURCE, type StudioFocus } from "./focus.js";
import { isAccessTool } from "./access.js";
import { applyEdit, editStatus, findEditRecord, markEdit, viewEdit, type EditScope } from "./edits.js";
import type { RoutineChange } from "./routines.js";
import { getGuild } from "../db/guilds.js";
import { getAgent, getAgentTask } from "../db/agents.js";
import { listRunHeaders } from "../db/runs.js";
import type pg from "pg";
import type { Queryable } from "../db/pg.js";
import {
  type ConversationMessageRow,
  type ConversationUsageRow,
  conversationUsageByOrg,
  getConversationMessage,
  insertConversationMessage,
  listConversationMessages,
  nextConversationSeq,
  updateConversationMessage,
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
    this.credentials = deps.credentials ?? coreModelCredentials(modelProviderStore(deps.db));
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
    user: Record<string, unknown>;
    org: Record<string, unknown>;
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
    const objective = String(guild.description ?? "").trim();
    const sourceGuild = {
      id: String(guild.id),
      name: String(guild.name),
      about: String(guild.about ?? ""),
      ...(objective ? { objective } : {}),
    };
    const members = (await studioInventory(this.deps.db, String(guild.id), null)).map((row) => hydrateStudioMember(row));
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
        session_id: String(session.id),
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
          session_id: String(session.id),
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

  async getOwnedSession(sessionId: string, user: Record<string, unknown>, org: Record<string, unknown>): Promise<Record<string, unknown>> {
    const session = await getStudioSession(this.deps.db, sessionId);
    if (!session || String(session.org_id) !== String(org.id)) {
      throw new StudioError(404, "studio session not found");
    }
    if (session.created_by_user_id && String(session.created_by_user_id) !== String(user.id)) {
      throw new StudioError(404, "studio session not found");
    }
    if (!session.created_by_user_id) {
      throw new StudioError(404, "studio session not found");
    }
    // Seeing the guild is checked on every request, not only at creation: a
    // user who can no longer see a private guild loses its sessions too.
    if (session.source_guild_id) {
      const guild = await getGuild(this.deps.db, String(session.source_guild_id));
      if (guild && !canSeeGuild(guild, String(user.id))) {
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

  viewSession(row: Record<string, unknown>): Record<string, unknown> {
    const config = (row.config_snapshot ?? {}) as Record<string, unknown>;
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

  async listConnections(session: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
    if (!session.source_guild_id) {
      return [];
    }
    const granted = new Set(grantedConnectionIds(session));
    const projected = await projectGuildConnections(
      this.previewDeps(),
      String(session.org_id),
      String(session.source_guild_id),
    );
    return projected.map((connection) => ({
      id: connection.id,
      server: connection.server,
      owner_scope: connection.owner_scope,
      owner_id: connection.owner_id,
      account_hint: connection.account_hint,
      status: connection.status,
      granted: granted.has(connection.id),
      readable_tools: connection.tools.filter((tool) => tool.read_only).map((tool) => tool.name),
      tool_count: connection.tools.length,
    }));
  }

  async setConnectionGrant(
    session: Record<string, unknown>,
    connectionId: string,
    granted: boolean,
  ): Promise<Record<string, unknown>> {
    const next = await this.grantedAfter(session, connectionId, granted);
    const updated = await updateStudioSession(
      this.deps.db,
      String(session.id),
      { granted_connection_ids: next },
      new Date(),
    );
    return this.viewSession(updated ?? { ...session, granted_connection_ids: next });
  }

  // The session's granted logins once one is granted or withdrawn. A grant
  // must name a connected login the source guild can reach.
  private async grantedAfter(
    session: Record<string, unknown>,
    connectionId: string,
    granted: boolean,
  ): Promise<string[]> {
    if (session.status !== "active") {
      throw new StudioConflictError("session is not active");
    }
    if (!session.source_guild_id) {
      throw new StudioUnprocessableError("source guild is gone");
    }
    const current = grantedConnectionIds(session);
    if (!granted) {
      return current.filter((id) => id !== connectionId);
    }
    const reach = await reachableConnection(
      this.deps.db,
      String(session.org_id),
      String(session.source_guild_id),
      connectionId,
    );
    if (!reach) {
      throw new StudioUnprocessableError("connection is not reachable from the source guild");
    }
    if (reach.connection.status !== "connected") {
      throw new StudioUnprocessableError(`connection is ${String(reach.connection.status)}`);
    }
    return current.includes(connectionId) ? current : [...current, connectionId];
  }

  // Grant or decline one login request from the Studio log. The answer and
  // who gave it are kept on the request's tool message; a grant also adds the
  // login to the session. The session lock serialises answers.
  async resolveLogin(
    session: Record<string, unknown>,
    user: Record<string, unknown>,
    seq: number,
    decision: "grant" | "decline",
  ): Promise<Record<string, unknown>> {
    this.assertLive(session);
    const sessionId = String(session.id);
    const updated = await withLockedSession(this.deps.db, sessionId, async (client, locked) => {
      const record = findLoginRecord(await getConversationMessage(client, "studio", sessionId, seq), seq);
      const status = loginStatus(record);
      if (status !== "pending") {
        throw new StudioConflictError(`login request is already ${status}`);
      }
      const now = new Date();
      await updateConversationMessage(
        client,
        "studio",
        { session_id: sessionId, seq, payload: record.payload, metadata: {
        ...record.metadata,
        access_status: decision === "grant" ? "granted" : "declined",
        access_resolved_at: now.toISOString(),
        resolved_by_user_id: user.id ?? null,
      } },
      );
      if (decision === "decline") {
        return locked;
      }
      const next = await this.grantedAfter(locked, record.connectionId, true);
      return (await updateStudioSession(client, sessionId, { granted_connection_ids: next }, now)) ?? locked;
    });
    return this.viewSession(updated);
  }

  async archive(session: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (session.generation_state === "generating") {
      throw new StudioConflictError("cannot archive while generating");
    }
    const now = new Date();
    const updated = await updateStudioSession(
      this.deps.db,
      String(session.id),
      { status: "archived", archived_at: now, generation_state: "idle" },
      now,
    );
    return this.viewSession(updated ?? session);
  }

  async setTarget(session: Record<string, unknown>, agentId: string | null): Promise<Record<string, unknown>> {
    return withLockedSession(this.deps.db, String(session.id), async (client, locked) => {
      if (locked.status !== "active") {
        throw new StudioConflictError("session cannot change inspector");
      }
      if (agentId) {
        const agent = await getAgent(this.deps.db, agentId);
        if (!agent || String(agent.guild_id) !== String(locked.source_guild_id)) {
          throw new StudioUnprocessableError("agent is not in the source guild");
        }
      }
      const updated = await updateStudioSession(
        client,
        String(locked.id),
        { selected_target_agent_id: agentId },
        new Date(),
      );
      return this.viewSession(updated ?? locked);
    });
  }

  async inventory(session: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
    this.assertLive(session);
    const rows = await studioInventory(this.deps.db, String(session.source_guild_id), String(session.id));
    return rows.map((row) => this.inventoryItem(row));
  }

  inventoryItem(row: Record<string, unknown>): Record<string, unknown> {
    const content = String(row.task_content ?? "");
    const member = hydrateStudioMember(row);
    const warnings: string[] = [];
    if (!content.trim()) warnings.push("empty_task");
    const errors = Array.isArray(row.latest_run_errors) ? row.latest_run_errors : [];
    if (errors.length) warnings.push("generation_errors");
    if (row.draft_id && Number(row.draft_base_version) !== Number(row.task_version)) {
      warnings.push("stale_draft");
    }
    return {
      id: row.id,
      name: row.name,
      focus: row.focus,
      avatar_shape: row.avatar_shape,
      avatar_color: row.avatar_color,
      scripting: (jsonObj(row.config) as Record<string, unknown> | null)?.scripting !== false,
      task_version: row.task_version,
      task_hash: row.task_hash,
      task_excerpt: member.task_excerpt,
      task_excerpt_truncated: member.task_excerpt_truncated,
      has_embeds: collectTaskEmbeds(content).length > 0,
      task_updated_at: row.task_updated_at,
      routine_count: Number(row.routine_count ?? 0),
      paused_count: Number(row.paused_count ?? 0),
      latest_run: row.latest_run_id
        ? {
            id: row.latest_run_id,
            kind: row.latest_run_kind,
            status: row.latest_run_status,
            at: row.latest_run_at,
            task_prompt_hash: row.latest_task_hash,
          }
        : null,
      draft_id: row.draft_id ?? null,
      draft_status: row.draft_status ?? null,
      warnings,
    };
  }

  async inspector(session: Record<string, unknown>, user: Record<string, unknown>, agentId: string): Promise<Record<string, unknown>> {
    this.assertLive(session);
    const agent = await this.requireGuildAgent(session, agentId);
    const actor = this.deps.artifacts.operatorContext(
      String(session.org_id),
      String(user.id),
      String(user.name ?? "operator"),
      { guildId: String(session.source_guild_id), agentId },
    );
    const task = await getAgentTask(this.deps.db, String(session.org_id), agentId);
    const memory = await this.deps.artifacts.getMemoryRow(actor, agentId);
    const standing = hydrateStanding({
      systemPath: this.deps.notesSystemPath,
      agentName: String(agent.name),
      agentId: String(agent.id),
    });
    const preview = await previewCurrentState(this.previewDeps(), agent);
    let effectiveTask = task?.content_text ?? "";
    let embedWarning: string | null = null;
    try {
      effectiveTask = await inlineTaskEmbeds(
        this.deps.artifacts,
        taskEmbedActor(String(session.org_id), agent),
        task?.content_text ?? "",
      );
    } catch (error) {
      embedWarning = error instanceof Error ? error.message : "embed preflight failed";
    }
    const sourceHash = task?.content_hash ?? hashArtifactContent("");
    const effectiveHash = promptHash(effectiveTask);
    const tools = await projectOfferedToolSchemas(this.previewDeps(), agent);
    const memoryText = await this.deps.artifacts.readMemory(actor, agentId);
    const memoryEnabled = memoryOf(jsonObj(agent.config));
    const composed = composeAgentSystemPrompt(
      standing,
      effectiveTask,
      preview.state,
      memoryText,
      memoryEnabled,
      memoryEnabled && schemasOffer(tools.schemas, "memory_write"),
    );
    const latestRun = (await listRunHeaders(this.deps.db, agentId, { limit: 1 }))[0] ?? null;
    const guidelinesHash = promptHash(standing);
    const memoryPromptHash = promptHash(memoryText);
    return {
      agent: {
        id: agent.id,
        name: agent.name,
        focus: agent.focus,
        config: agent.config,
      },
      guidelines: {
        ownership: "shared",
        editable: false,
        content: standing,
        content_hash: promptHash(standing),
      },
      task: {
        ownership: "operator-owned",
        editable: true,
        display_path: task
          ? displayPathFor({
              orgId: String(session.org_id),
              level: "agent",
              ownerId: agentId,
              kind: "task",
              path: "",
              key: "task.md",
            })
          : null,
        version: task?.version ?? null,
        content: task?.content_text ?? "",
        content_hash: sourceHash,
        effective_hash: effectiveHash,
        effective_matches_source: sourceHash === effectiveHash,
        has_embeds: collectTaskEmbeds(task?.content_text ?? "").length > 0,
        embed_warning: embedWarning,
      },
      state: {
        ownership: "derived",
        editable: false,
        projected_at: preview.projected_at,
        content: preview.state,
      },
      memory: {
        ownership: "agent-owned",
        editable: false,
        content: memory?.content_text ?? "",
        content_hash: memory?.content_hash ?? null,
        prompt_hash: memoryPromptHash,
      },
      effective_prompt: {
        content: composed,
        hash: promptHash(composed),
        task_content: effectiveTask,
        sections: {
          guidelines_hash: guidelinesHash,
          task_hash: effectiveHash,
          memory_hash: memoryPromptHash,
        },
        latest_run: latestRun
          ? {
              id: latestRun.id,
              kind: latestRun.kind,
              created_at: iso(latestRun.created_at),
              guidelines_match: String(latestRun.system_prompt_hash ?? "") === guidelinesHash,
              task_match: String(latestRun.task_prompt_hash ?? "") === effectiveHash,
              memory_match: String(latestRun.memory_prompt_hash ?? "") === memoryPromptHash,
            }
          : null,
      },
      offered_tools: {
        catalog_revision: tools.catalog_revision,
        count: tools.schemas.length,
      },
      generating: this.deps.isAgentBusy?.(agentId) ?? false,
    };
  }

  async memoryTimeline(
    session: Record<string, unknown>,
    user: Record<string, unknown>,
    agentId: string,
  ): Promise<Record<string, unknown>> {
    this.assertLive(session);
    const agent = await this.requireGuildAgent(session, agentId);
    const actor = this.deps.artifacts.operatorContext(
      String(session.org_id),
      String(user.id),
      String(user.name ?? "operator"),
      { guildId: String(session.source_guild_id), agentId },
    );
    return memoryHistory(this.deps, actor, { id: String(agent.id), name: String(agent.name) });
  }

  /** The system message for this generation, from the roster rows the caller already read. */
  composeLiveSystem(
    session: Record<string, unknown>,
    rows: Array<Record<string, unknown>>,
  ): { content: string; hash: string } {
    const snapshot = (session.source_guild_snapshot ?? {}) as {
      name?: string;
      about?: string;
      objective?: string;
    };
    const config = (session.config_snapshot ?? {}) as Record<string, unknown>;
    const members = rows.map((row) => hydrateStudioMember(row));
    return composeStudioSystemMessage({
      mode: String(session.mode ?? "optimize"),
      template: readStudioSystemTemplate({ guidelinesPath: this.deps.notesSystemPath }),
      sourceGuild: session.source_guild_id
        ? {
            id: String(session.source_guild_id),
            name: String(snapshot.name ?? ""),
            about: String(snapshot.about ?? ""),
            ...(snapshot.objective ? { objective: String(snapshot.objective) } : {}),
          }
        : null,
      members,
      config: {
        model: config.model,
        temperature: config.temperature,
        max_tokens: config.max_tokens,
        max_steps: config.max_steps,
        max_tool_calls: config.max_tool_calls,
        max_input_tokens: config.max_input_tokens,
      },
    });
  }

  async refreshSystemMessage(
    session: Record<string, unknown>,
    rows: Array<Record<string, unknown>>,
    client?: pg.PoolClient,
  ): Promise<string> {
    const system = this.composeLiveSystem(session, rows);
    const existing = await getConversationMessage(client ?? this.deps.db, "studio", String(session.id), 0);
    const metadata =
      existing?.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>)
        : {};
    if (existing && String(metadata.system_prompt_hash ?? "") !== system.hash) {
      await updateConversationMessage(client ?? this.deps.db, "studio", {
        session_id: String(session.id),
        seq: 0,
        payload: { role: "system", content: system.content },
        metadata: { ...metadata, source: "studio_system", system_prompt_hash: system.hash, refreshed: true },
      });
    }
    return system.content;
  }

  async postMessage(
    session: Record<string, unknown>,
    user: Record<string, unknown>,
    content: string,
    focusInput?: unknown,
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
              orgId: String(session.org_id),
              sourceGuildId: String(session.source_guild_id),
              user,
            },
            focusInput,
          );
    const started = await withLockedSession(this.deps.db, String(session.id), async (client, locked) => {
      if (locked.status !== "active") {
        throw new StudioConflictError("session cannot generate");
      }
      if (locked.generation_state !== "idle") {
        throw new StudioConflictError("studio session is already generating");
      }
      const now = new Date();
      await claimCoachRun(this.policy, coachRunClaims(client), String(locked.org_id), now);
      const rows = await studioInventory(this.deps.db, String(locked.source_guild_id), String(locked.id));
      const systemContent = await this.refreshSystemMessage(locked, rows, client);
      const generation = Number(locked.generation_number) + 1;
      let seq = await nextConversationSeq(client, "studio", String(locked.id));
      if (focus) {
        // A stored user row, so the pin stays in the projected history of
        // every later turn of this session.
        await insertConversationMessage(
          client,
          "studio",
          {
            session_id: String(locked.id),
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
          session_id: String(locked.id),
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
        String(locked.id),
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
    const drafts = await listStudioDraftHeads(this.deps.db, String(started.session.id));
    const generationContext = composeGenerationContext({
      sourceGuild: { id: String(started.session.source_guild_id) },
      roster: started.rows.map((row) => this.inventoryItem(row)),
      draft: drafts[0] ?? null,
    });
    const limits = (await this.policy.standing(String(started.session.org_id))).limits.coach.studio;
    this.runner.start({
      session: {
        ...started.session,
        config_snapshot: { ...((started.session.config_snapshot ?? {}) as Record<string, unknown>), ...limits },
      },
      user,
      generation: started.generation,
      generationContext,
      systemContent: started.systemContent,
      toolContext: {
        session: started.session,
        user,
        orgId: String(started.session.org_id),
        sourceGuildId: String(started.session.source_guild_id),
        artifacts: this.deps.artifacts,
        db: this.deps.db,
        schedules: this.deps.schedules,
        drafts: this.drafts,
        preview: this.previewDeps(),
        notesSystemPath: this.deps.notesSystemPath,
        mcp: this.deps.mcp ?? null,
      },
    });
    return this.viewSession(started.session);
  }

  /** The guild's agents as the coach sees them, outside any session. */
  guildInventory(guildId: string): Promise<StudioInventoryRow[]> {
    return studioInventory(this.deps.db, guildId, null);
  }

  /** The session's conversation, in order. */
  messages(session: Record<string, unknown>): Promise<ConversationMessageRow[]> {
    return listConversationMessages(this.deps.db, "studio", String(session.id));
  }

  /** Every draft of the session, newest first. */
  sessionDrafts(session: Record<string, unknown>): Promise<StudioDraftRow[]> {
    return listStudioDrafts(this.deps.db, String(session.id));
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

  async cancel(session: Record<string, unknown>): Promise<Record<string, unknown>> {
    await updateStudioSession(this.deps.db, String(session.id), { generation_state: "cancelling" }, new Date());
    this.runner.cancel(String(session.id));
    return this.viewSession({ ...session, generation_state: "cancelling" });
  }

  subscribe(sessionId: string): EventQueue<[string, Record<string, unknown>]> {
    return this.runner.subscribe(sessionId);
  }

  unsubscribe(sessionId: string, queue: EventQueue<[string, Record<string, unknown>]>): void {
    this.runner.unsubscribe(sessionId, queue);
  }

  async continueSession(
    session: Record<string, unknown>,
    user: Record<string, unknown>,
    org: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (session.blocked_reason !== "input_token_limit" && session.status !== "blocked") {
      throw new StudioUnprocessableError("session is not blocked on input tokens");
    }
    if (!session.source_guild_id) {
      throw new StudioUnprocessableError("source guild is gone");
    }
    const config = (session.config_snapshot ?? {}) as Record<string, unknown>;
    const heads = await listStudioDraftHeads(this.deps.db, String(session.id));
    const summary = `Continue from Studio session ${session.id}. Active draft heads: ${heads.map((row) => row.id).join(", ") || "none"}.`;
    return this.createSession({
      user,
      org,
      mode: "optimize",
      sourceGuildId: String(session.source_guild_id),
      model: String(config.model ?? ""),
      temperature: Number(config.temperature ?? STUDIO_DEFAULT_TEMPERATURE),
      parentSessionId: String(session.id),
      summary,
      selectedTargetAgentId: session.selected_target_agent_id ? String(session.selected_target_agent_id) : null,
    });
  }

  async publishDraft(
    session: Record<string, unknown>,
    user: Record<string, unknown>,
    draftId: string,
    options: { orphan?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const result = await this.drafts.publish({
      session,
      user,
      draftId,
      db: this.deps.db,
      preview: this.previewDeps(),
      notesSystemPath: this.deps.notesSystemPath,
      ...(options.orphan ? { orphan: true } : {}),
    });
    if (result.outcome === "published" && this.deps.publishFilesChanged && session.source_guild_id) {
      await this.deps.publishFilesChanged(String(session.source_guild_id));
    }
    const targetId = String((result.draft as { target_agent_id?: string } | undefined)?.target_agent_id ?? "");
    return {
      ...result,
      target_generating: targetId ? Boolean(this.deps.isAgentBusy?.(targetId)) : false,
    };
  }

  private editScope(session: Record<string, unknown>, user: Record<string, unknown>): EditScope {
    return {
      orgId: String(session.org_id),
      sourceGuildId: String(session.source_guild_id),
      sessionId: String(session.id),
      user,
      db: this.deps.db,
      artifacts: this.deps.artifacts,
      schedules: this.deps.schedules,
    };
  }

  async getEdit(
    session: Record<string, unknown>,
    user: Record<string, unknown>,
    seq: number,
  ): Promise<Record<string, unknown>> {
    if (!session.source_guild_id) {
      throw new StudioUnprocessableError("source guild is gone");
    }
    const record = findEditRecord(await listConversationMessages(this.deps.db, "studio", String(session.id)), seq);
    return viewEdit(this.editScope(session, user), record);
  }

  // Apply or decline one edit request from the Studio log. The session lock
  // serialises answers, so a request resolves once.
  async resolveEdit(
    session: Record<string, unknown>,
    user: Record<string, unknown>,
    seq: number,
    decision: "apply" | "decline",
  ): Promise<Record<string, unknown>> {
    this.assertLive(session);
    const scope = this.editScope(session, user);
    const userId = user.id === undefined || user.id === null ? null : String(user.id);
    const outcome = await withLockedSession(this.deps.db, String(session.id), async () => {
      const record = findEditRecord(await listConversationMessages(this.deps.db, "studio", String(session.id)), seq);
      if (editStatus(record) !== "pending") {
        throw new StudioConflictError(`edit request is already ${editStatus(record)}`);
      }
      if (decision === "decline") {
        await markEdit(this.deps.db, String(session.id), record, { status: "declined", version: null, userId });
        return { record, applied: null };
      }
      const applied = await applyEdit(scope, record);
      await markEdit(this.deps.db, String(session.id), record, {
        status: "applied",
        version: applied.version,
        userId,
      });
      return { record, applied };
    });
    if (outcome.applied?.guild) {
      const guild = outcome.applied.guild;
      const description = String(guild.description ?? "").trim();
      await updateStudioSession(
        this.deps.db,
        String(session.id),
        {
          source_guild_snapshot: {
            id: String(guild.id),
            name: String(guild.name),
            about: String(guild.about ?? ""),
            ...(description ? { objective: description } : {}),
          },
        },
        new Date(),
      );
    } else if (outcome.applied?.routine) {
      await this.deps.publishRoutinesChanged?.(String(session.source_guild_id), outcome.applied.routine);
    } else if (outcome.applied && !isAccessTool(outcome.record.toolName) && this.deps.publishFilesChanged) {
      await this.deps.publishFilesChanged(String(session.source_guild_id));
    }
    const record = findEditRecord(await listConversationMessages(this.deps.db, "studio", String(session.id)), seq);
    return viewEdit(scope, record);
  }

  assertLive(session: Record<string, unknown>): void {
    if (session.status === "archived") {
      throw new StudioConflictError("session is archived");
    }
    if (!session.source_guild_id || session.status === "blocked") {
      throw new StudioConflictError("session source is not live");
    }
  }

  async requireGuildAgent(session: Record<string, unknown>, agentId: string): Promise<Record<string, unknown>> {
    const agent = await getAgent(this.deps.db, agentId);
    if (!agent || String(agent.guild_id) !== String(session.source_guild_id)) {
      throw new StudioError(404, "agent not found");
    }
    return agent;
  }
}

export { viewDraft, studioSystemHash, createHash };
