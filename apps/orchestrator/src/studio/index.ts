import { createHash } from "node:crypto";
import type { ArtifactStore } from "../artifacts/index.js";
import { collectTaskEmbeds, displayPathFor, hashArtifactContent, inlineTaskEmbeds } from "../artifacts/index.js";
import { memoryHistory } from "../memory/history.js";
import { canSeeGuild } from "../guilds/validation.js";
import { DEFAULT_MODEL, isMarketplaceModel } from "../llm/catalog.js";
import { newId } from "../lib/ids.js";
import { EventQueue } from "../lib/event.js";
import { memoryOf } from "../agents/validation.js";
import { composeAgentSystemPrompt, hydrateStanding, promptHash, schemasOffer } from "../prompts/index.js";
import type { Repositories } from "../db/repositories.js";
import { jsonObj } from "../db/json.js";
import { iso } from "../db/views.js";
import type { Scripts } from "../scripts/catalog.js";
import type { Schedules } from "../schedules/service.js";
import { AdmissionCoordinator } from "../generation/admission.js";
import { OPEN_POLICY, claimCoachRun, type OrgPolicy } from "../policy/index.js";
import {
  STUDIO_DEFAULT_TEMPERATURE,
  STUDIO_MAX_STEPS,
} from "./constants.js";
import { StudioConflictError, StudioError, StudioUnprocessableError } from "./errors.js";
import { StudioDrafts, viewDraft } from "./drafts.js";
import { StudioRunner } from "./runner.js";
import { StudioStore } from "./store.js";
import { composeGenerationContext, composeStudioSystemMessage, hydrateStudioMember, readStudioSystemTemplate, studioSystemHash } from "./system.js";
import { studioToolSchemas } from "./tools.js";
import { previewCurrentState, projectGuildConnections, projectOfferedToolSchemas, type PreviewDeps } from "./preview.js";
import { grantedConnectionIds, reachableConnection, type StudioMcpClient } from "./connections.js";
import { resolveStudioFocus, STUDIO_FOCUS_SOURCE, type StudioFocus } from "./focus.js";
import { applyEdit, editStatus, findEditRecord, markEdit, viewEdit, type EditScope } from "./edits.js";

export type StudioServiceDeps = {
  repo: Repositories;
  artifacts: ArtifactStore;
  scripts: Scripts;
  schedules: Schedules;
  notesSystemPath: string;
  mcp?: StudioMcpClient | null;
  admission?: AdmissionCoordinator;
  policy?: OrgPolicy;
  resolveOrgApiKey?: (orgId: string, model: string) => Promise<string | null>;
  publishFilesChanged?: (guildId: string) => Promise<void>;
  isAgentBusy?: (agentId: string) => boolean;
};

export class StudioService {
  store: StudioStore;
  drafts: StudioDrafts;
  runner: StudioRunner;
  admission: AdmissionCoordinator;
  policy: OrgPolicy;

  constructor(public deps: StudioServiceDeps) {
    this.store = new StudioStore(deps.repo.pool);
    this.drafts = new StudioDrafts(this.store, deps.artifacts);
    this.admission = deps.admission ?? new AdmissionCoordinator();
    this.policy = deps.policy ?? OPEN_POLICY;
    this.runner = new StudioRunner({
      store: this.store,
      admission: this.admission,
      policy: this.policy,
      getOrgMonthlyUsage: (orgId, month) => deps.repo.getOrgMonthlyUsage(orgId, month),
      ...(deps.resolveOrgApiKey ? { resolveOrgApiKey: deps.resolveOrgApiKey } : {}),
    });
  }

  previewDeps(): PreviewDeps {
    return {
      db: this.deps.repo,
      artifacts: this.deps.artifacts,
      scripts: this.deps.scripts,
    };
  }

  async reconcile(): Promise<void> {
    const result = await this.store.pool.query(
      `SELECT * FROM studio_sessions WHERE generation_state IN ('generating', 'cancelling')`,
    );
    for (const row of result.rows as Array<Record<string, unknown>>) {
      await this.runner.reconcile({
        ...row,
        config_snapshot: row.config_snapshot,
        errors: row.errors,
      });
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
    const guild = await this.deps.repo.getGuild(args.sourceGuildId);
    if (
      !guild ||
      String(guild.org_id) !== String(args.org.id) ||
      !canSeeGuild(guild, String(args.user.id))
    ) {
      throw new StudioError(404, "guild not found");
    }
    const model = this.validateModel(args.model);
    const temperature = this.validateTemperature(args.temperature);
    if (args.parentSessionId) {
      const parent = await this.store.getSession(args.parentSessionId);
      if (
        !parent ||
        String(parent.org_id) !== String(args.org.id) ||
        String(parent.created_by_user_id ?? "") !== String(args.user.id)
      ) {
        throw new StudioError(404, "parent studio session not found");
      }
    }
    const template = readStudioSystemTemplate();
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
    const members = (await this.store.inventory(String(guild.id), null))
      .filter((row) => !row.archived_at)
      .map((row) => hydrateStudioMember(row));
    const system = composeStudioSystemMessage({
      mode: "optimize",
      sourceGuild,
      members,
      config: coachConfig,
      template,
    });
    const now = new Date();
    const session = await this.store.insertSession({
      id: newId("stu"),
      org_id: args.org.id,
      created_by_user_id: args.user.id,
      created_by_name: args.user.name ?? "operator",
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
      now,
    });
    await this.store.insertMessage(
      String(session.id),
      0,
      0,
      { role: "system", content: system.content },
      { source: "studio_system", system_prompt_hash: system.hash },
      now,
    );
    if (args.summary) {
      await this.store.insertMessage(
        String(session.id),
        1,
        0,
        { role: "user", content: args.summary },
        { source: "continuation" },
        now,
      );
    }
    return this.viewSession(session);
  }

  validateModel(model: string): string {
    const id = (model || DEFAULT_MODEL).trim();
    if (!isMarketplaceModel(id)) {
      throw new StudioUnprocessableError("unknown model");
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
    const rows = await this.store.listSessions(orgId, userId);
    return rows.map((row) => this.viewSession(row));
  }

  async getOwnedSession(sessionId: string, user: Record<string, unknown>, org: Record<string, unknown>): Promise<Record<string, unknown>> {
    const session = await this.store.getSession(sessionId);
    if (!session || String(session.org_id) !== String(org.id)) {
      throw new StudioError(404, "studio session not found");
    }
    if (session.created_by_user_id && String(session.created_by_user_id) !== String(user.id)) {
      throw new StudioError(404, "studio session not found");
    }
    if (!session.created_by_user_id) {
      throw new StudioError(404, "studio session not found");
    }
    if (!session.source_guild_id && session.status === "active") {
      await this.store.updateSession(sessionId, { status: "blocked", blocked_reason: "source_deleted" }, new Date());
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
    if (session.status !== "active") {
      throw new StudioConflictError("session is not active");
    }
    if (!session.source_guild_id) {
      throw new StudioUnprocessableError("source guild is gone");
    }
    const current = grantedConnectionIds(session);
    let next: string[];
    if (granted) {
      const reach = await reachableConnection(
        this.deps.repo,
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
      next = current.includes(connectionId) ? current : [...current, connectionId];
    } else {
      next = current.filter((id) => id !== connectionId);
    }
    const updated = await this.store.updateSession(
      String(session.id),
      { granted_connection_ids: next },
      new Date(),
    );
    return this.viewSession(updated ?? { ...session, granted_connection_ids: next });
  }

  async archive(session: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (session.generation_state === "generating") {
      throw new StudioConflictError("cannot archive while generating");
    }
    const now = new Date();
    const updated = await this.store.updateSession(
      String(session.id),
      { status: "archived", archived_at: now, generation_state: "idle" },
      now,
    );
    return this.viewSession(updated ?? session);
  }

  async setTarget(session: Record<string, unknown>, agentId: string | null): Promise<Record<string, unknown>> {
    return this.store.withSessionLock(String(session.id), async (client, locked) => {
      if (locked.status !== "active") {
        throw new StudioConflictError("session cannot change inspector");
      }
      if (agentId) {
        const agent = await this.deps.repo.getAgent(agentId);
        if (!agent || String(agent.guild_id) !== String(locked.source_guild_id)) {
          throw new StudioUnprocessableError("agent is not in the source guild");
        }
      }
      const updated = await this.store.updateSession(
        String(locked.id),
        { selected_target_agent_id: agentId },
        new Date(),
        client,
      );
      return this.viewSession(updated ?? locked);
    });
  }

  async inventory(session: Record<string, unknown>, includeArchived = false): Promise<Array<Record<string, unknown>>> {
    this.assertLive(session);
    const rows = await this.store.inventory(String(session.source_guild_id), String(session.id));
    return rows
      .filter((row) => includeArchived || !row.archived_at)
      .map((row) => this.inventoryItem(row));
  }

  inventoryItem(row: Record<string, unknown>): Record<string, unknown> {
    const content = String(row.task_content ?? "");
    const member = hydrateStudioMember(row);
    const warnings: string[] = [];
    if (!content.trim()) warnings.push("empty_task");
    const meta = row.latest_run_metadata as Record<string, unknown> | undefined;
    const metadata = meta && typeof meta === "object" ? meta : {};
    if (metadata.memory_skipped) warnings.push("memory_skipped");
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
      archived: Boolean(row.archived_at),
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
      publishable: !row.archived_at,
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
    const task = await this.deps.repo.getAgentTask(String(session.org_id), agentId);
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
      effectiveTask = await inlineTaskEmbeds(this.deps.artifacts, actor, task?.content_text ?? "");
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
    const runs = await this.deps.repo.listRuns(agentId);
    const latestRun = runs[0] ?? null;
    const guidelinesHash = promptHash(standing);
    const memoryPromptHash = promptHash(memoryText);
    return {
      agent: {
        id: agent.id,
        name: agent.name,
        focus: agent.focus,
        archived: Boolean(agent.archived_at),
        config: agent.config,
        publishable: !agent.archived_at,
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

  async composeLiveSystem(session: Record<string, unknown>): Promise<{ content: string; hash: string }> {
    const snapshot = (session.source_guild_snapshot ?? {}) as {
      name?: string;
      about?: string;
      objective?: string;
    };
    const config = (session.config_snapshot ?? {}) as Record<string, unknown>;
    const members = session.source_guild_id
      ? (await this.store.inventory(String(session.source_guild_id), String(session.id)))
          .filter((row) => !row.archived_at)
          .map((row) => hydrateStudioMember(row))
      : [];
    return composeStudioSystemMessage({
      mode: String(session.mode ?? "optimize"),
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
    client?: Parameters<StudioStore["updateMessage"]>[4],
  ): Promise<string> {
    const system = await this.composeLiveSystem(session);
    const existing = await this.store.getMessage(String(session.id), 0, client);
    const metadata =
      existing?.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>)
        : {};
    if (existing && String(metadata.system_prompt_hash ?? "") !== system.hash) {
      await this.store.updateMessage(
        String(session.id),
        0,
        { role: "system", content: system.content },
        { ...metadata, source: "studio_system", system_prompt_hash: system.hash, refreshed: true },
        client,
      );
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
              repo: this.deps.repo,
              artifacts: this.deps.artifacts,
              pool: this.deps.repo.pool,
              orgId: String(session.org_id),
              sourceGuildId: String(session.source_guild_id),
              user,
            },
            focusInput,
          );
    const started = await this.store.withSessionLock(String(session.id), async (client, locked) => {
      if (locked.status !== "active") {
        throw new StudioConflictError("session cannot generate");
      }
      if (locked.generation_state !== "idle") {
        throw new StudioConflictError("studio session is already generating");
      }
      const now = new Date();
      await claimCoachRun(this.policy, this.deps.repo, String(locked.org_id), now, client);
      const systemContent = await this.refreshSystemMessage(locked, client);
      const generation = Number(locked.generation_number) + 1;
      let seq = await this.store.nextSeq(String(locked.id), client);
      if (focus) {
        // A stored user row, so the pin stays in the projected history of
        // every later turn of this session.
        await this.store.insertMessage(
          String(locked.id),
          seq,
          generation,
          { role: "user", content: focus.content },
          { generation, source: STUDIO_FOCUS_SOURCE, focus: focus.focus },
          now,
          client,
        );
        seq += 1;
      }
      await this.store.insertMessage(
        String(locked.id),
        seq,
        generation,
        { role: "user", content },
        { generation, source: "ui" },
        now,
        client,
      );
      const token = newId("stg");
      const updated = await this.store.updateSession(
        String(locked.id),
        {
          generation_state: "generating",
          generation_number: generation,
          generation_token: token,
          generation_started_at: now,
        },
        now,
        client,
      );
      return { session: updated ?? locked, generation, systemContent };
    });
    const inventory = await this.inventory(started.session);
    const drafts = await this.store.listDraftHeads(String(started.session.id));
    const snapshot = (started.session.source_guild_snapshot ?? {}) as {
      name?: string;
      about?: string;
      objective?: string;
    };
    const generationContext = composeGenerationContext({
      sourceGuild: {
        id: String(started.session.source_guild_id),
        name: String(snapshot.name ?? ""),
        ...(snapshot.about ? { about: String(snapshot.about) } : {}),
        ...(snapshot.objective ? { objective: String(snapshot.objective) } : {}),
      },
      roster: inventory,
      target: null,
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
      targetAgentId: null,
      generationContext,
      systemContent: started.systemContent,
      toolContext: {
        session: started.session,
        user,
        orgId: String(started.session.org_id),
        sourceGuildId: String(started.session.source_guild_id),
        targetAgentId: null,
        store: this.store,
        artifacts: this.deps.artifacts,
        repo: this.deps.repo,
        schedules: this.deps.schedules,
        drafts: this.drafts,
        preview: this.previewDeps(),
        notesSystemPath: this.deps.notesSystemPath,
        mcp: this.deps.mcp ?? null,
      },
    });
    return this.viewSession(started.session);
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
    const heads = await this.store.listDraftHeads(String(session.id));
    const summary = `Continue from Studio session ${session.id}. Active draft heads: ${heads.map((row) => row.id).join(", ") || "none"}.`;
    return this.createSession({
      user,
      org,
      mode: "optimize",
      sourceGuildId: String(session.source_guild_id),
      model: String(config.model ?? DEFAULT_MODEL),
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
      repo: this.deps.repo,
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
      user,
      repo: this.deps.repo,
      artifacts: this.deps.artifacts,
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
    const record = findEditRecord(await this.store.listMessages(String(session.id)), seq);
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
    const outcome = await this.store.withSessionLock(String(session.id), async () => {
      const record = findEditRecord(await this.store.listMessages(String(session.id)), seq);
      if (editStatus(record) !== "pending") {
        throw new StudioConflictError(`edit request is already ${editStatus(record)}`);
      }
      if (decision === "decline") {
        await markEdit(this.store, String(session.id), record, "declined", null);
        return { record, applied: null };
      }
      const applied = await applyEdit(scope, record);
      await markEdit(this.store, String(session.id), record, "applied", applied.version);
      return { record, applied };
    });
    if (outcome.applied?.guild) {
      const guild = outcome.applied.guild;
      const description = String(guild.description ?? "").trim();
      await this.store.updateSession(
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
    } else if (outcome.applied && this.deps.publishFilesChanged) {
      await this.deps.publishFilesChanged(String(session.source_guild_id));
    }
    const record = findEditRecord(await this.store.listMessages(String(session.id)), seq);
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
    const agent = await this.deps.repo.getAgent(agentId);
    if (!agent || String(agent.guild_id) !== String(session.source_guild_id)) {
      throw new StudioError(404, "agent not found");
    }
    return agent;
  }
}

export { viewDraft, studioSystemHash, createHash };
