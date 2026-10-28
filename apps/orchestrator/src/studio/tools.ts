import { ArtifactError, collectTaskEmbeds, displayPathFor, hashArtifactContent, inlineTaskEmbeds, listFileChanges, parseDisplayPath, taskEmbedActor, type ArtifactStore } from "../artifacts/index.js";
import { jsonObj } from "../db/json.js";
import { iso } from "../db/views.js";
import { buildMemoryTimeline, memoryDiffText, type MemoryTimelineEntry } from "../memory/timeline.js";
import { memoryOf } from "../agents/validation.js";
import { composeAgentSystemPrompt, hydrateStanding, promptHash, schemasOffer } from "../prompts/index.js";
import { argInteger, argString, functionSchema } from "../toolbox/schema.js";
import { scheduleItem } from "../schedules/item.js";
import { capBytes } from "../toolbox/output.js";
import type { AgentScheduleRow } from "../db/schedules.js";
import type { Schedules } from "../schedules/service.js";
import { previewCurrentState, projectAgentAccess, projectOfferedToolSchemas, type PreviewDeps } from "./preview.js";
import { wrapEvidence } from "./system.js";
import { StudioUnprocessableError } from "./errors.js";
import { ScriptError } from "../scripts/validation.js";
import { ABOUT_MAX, DESCRIPTION_MAX } from "../guilds/validation.js";
import { NATIVE_TOOLS } from "../seed/catalog.js";
import {
  STUDIO_CONNECTION_ACCESS_WIDGET,
  callConnectionTool,
  connectionSummary,
  grantedConnectionIds,
  reachableConnection,
  type StudioMcpClient,
} from "./connections.js";
import {
  STUDIO_ARTIFACT_LIST_MAX,
  STUDIO_DEFAULT_CONTEXT_SECTIONS,
  STUDIO_DEFAULT_LIMIT,
  STUDIO_GROUP_LIST_MAX,
  STUDIO_REVISION_LIST_MAX,
  STUDIO_RUN_LIST_MAX,
  STUDIO_TOOL_RESULT_MAX_BYTES,
  STUDIO_TOTAL_RETURNED_BYTES,
} from "./constants.js";
import type { StudioDraftService } from "./drafts.js";
import {
  accessEditRequest,
  editRequest,
  loadGuildBase,
  loadMemoryBase,
  loadNoteBase,
  noteEditRequest,
  routineEditRequest,
  tableEditRequest,
  type EditScope,
} from "./edits.js";
import { editActionOf } from "./actions.js";
import { listTables, readTable } from "./tables.js";
import { studioReachesParsed, studioReachesPath } from "./reach.js";
import { getAgent, getAgentTask, listAgentTaskRevisions, listAgents, type AgentRow } from "../db/agents.js";
import { listSchedules, listSchedulesForGuild } from "../db/schedules.js";
import { getRun, listMessages, listRunHeaders, routineRunStats, type MessageRow, type RunHeaderRow } from "../db/runs.js";
import { listGroupMessages } from "../db/group-chat.js";
import { listGuildsForUser } from "../db/guilds.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import { getStudioSession, type StudioSessionRow } from "../db/studio.js";
import type { UserRow } from "../db/users.js";
import { findNotes, getByDisplayPath } from "../artifacts/notes.js";
import { operatorContext } from "../artifacts/store.js";
import { getMemoryRow, listRevisions, readStoredMemory } from "../artifacts/memory.js";
import { embedSource } from "../artifacts/embeds.js";

export type StudioToolContext = {
  session: StudioSessionRow;
  user: UserRow;
  orgId: string;
  sourceGuildId: string;
  generation: number;
  nextMessageSeq?: number;
  artifacts: ArtifactStore;
  db: Queryable;
  schedules: Schedules;
  drafts: StudioDraftService;
  preview: PreviewDeps;
  notesSystemPath: string;
  mcp?: StudioMcpClient | null;
};

export type StudioTool = {
  name: string;
  schema: Record<string, unknown>;
  handler: (ctx: StudioToolContext, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

function clampLimit(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "number" && Number.isInteger(value) ? value : fallback;
  return Math.min(Math.max(n, 1), max);
}

function cursorOffset(cursor: unknown): number {
  if (typeof cursor !== "string" || !cursor) {
    return 0;
  }
  const n = Number(cursor);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

async function resolveHandle(ctx: StudioToolContext, handle: string | undefined): Promise<AgentRow> {
  const agent = await resolveSourceGuildAgent(sourceGuildAgents(ctx.db), ctx, handle);
  if (!agent) {
    throw new StudioUnprocessableError(handle ? "agent is not in the source guild" : "agent handle required");
  }
  return agent;
}

export function studioAgentHandleFromArgs(args: Record<string, unknown>): string {
  for (const key of ["agent_id", "agent", "agent_name"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function normalizeAgentHandle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** The db/ functions an agent of the source guild is found by handle through, on `db`. */
export function sourceGuildAgents(db: Queryable) {
  return {
    getAgent: bindQuery(db, getAgent),
    listAgents: bindQuery(db, listAgents),
  };
}

export type SourceGuildAgents = ReturnType<typeof sourceGuildAgents>;

export async function resolveSourceGuildAgent(
  agents: SourceGuildAgents,
  ctx: Pick<StudioToolContext, "sourceGuildId" | "orgId">,
  handle: string | null | undefined,
): Promise<AgentRow | null> {
  const needle = String(handle ?? "").trim();
  if (!needle) {
    return null;
  }
  const byId = await agents.getAgent(needle);
  if (byId && String(byId.guild_id) === String(ctx.sourceGuildId) && (!ctx.orgId || String(byId.org_id) === ctx.orgId)) {
    return byId;
  }
  const members = await agents.listAgents(ctx.sourceGuildId);
  const lower = needle.toLowerCase();
  const normalized = normalizeAgentHandle(needle);
  const live = members.filter((row) => String(row.guild_id) === String(ctx.sourceGuildId));
  const match =
    live.find((row) => row.id === needle || String(row.name).toLowerCase() === lower) ??
    live.find((row) => normalizeAgentHandle(String(row.name)) === normalized) ??
    null;
  // The roster query omits org and guild columns; projections need the full row.
  return match ? agents.getAgent(String(match.id)) : null;
}

// The run facts a listing carries: enough to pick a run without its transcript.
function runHeader(row: RunHeaderRow): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    task_prompt_hash: row.task_prompt_hash,
    system_prompt_hash: row.system_prompt_hash,
    schedule_id: row.schedule_id,
    instruction_hash: row.metadata.instruction_hash ?? null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    error_count: row.errors.length,
  };
}

function truncatePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8");
  if (encoded.length <= STUDIO_TOTAL_RETURNED_BYTES) {
    return payload;
  }
  return {
    truncated: true,
    error: "result exceeded byte cap; narrow the range or continue from the cursor",
    byte_cap: STUDIO_TOTAL_RETURNED_BYTES,
  };
}

export function sliceStudioBytes(
  text: string,
  cursor: unknown,
  maxBytes = STUDIO_TOOL_RESULT_MAX_BYTES,
): { text: string; next_cursor: string | null; truncated: boolean } {
  const offset = cursorOffset(cursor);
  const encoded = Buffer.from(text, "utf8");
  if (offset >= encoded.length) {
    return { text: "", next_cursor: null, truncated: offset > 0 };
  }
  if (encoded.length - offset <= maxBytes) {
    return {
      text: encoded.subarray(offset).toString("utf8"),
      next_cursor: null,
      truncated: offset > 0,
    };
  }
  return {
    text: encoded.subarray(offset, offset + maxBytes).toString("utf8"),
    next_cursor: String(offset + maxBytes),
    truncated: true,
  };
}

function fitStudioPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (Buffer.from(JSON.stringify(payload), "utf8").length <= STUDIO_TOTAL_RETURNED_BYTES) {
    return payload;
  }
  const omitted: string[] = [];
  const next = { ...payload };
  for (const key of ["effective_prompt", "state", "memory", "config", "effective_prompt_headers"]) {
    if (!(key in next)) continue;
    delete next[key];
    omitted.push(key);
    if (Buffer.from(JSON.stringify(next), "utf8").length <= STUDIO_TOTAL_RETURNED_BYTES) {
      return {
        ...next,
        omitted_sections: omitted,
        hint: "request omitted sections in a separate studio_get_agent_context call",
      };
    }
  }
  return truncatePayload(next);
}

export const studioGetGuidelines: StudioTool = {
  name: "studio_get_guidelines",
  schema: functionSchema("studio_get_guidelines", "Inspect the shared read-only Guidelines source.", {}, []),
  async handler(ctx) {
    const standing = hydrateStanding({
      systemPath: ctx.notesSystemPath,
      agentName: "studio",
      agentId: "studio",
    });
    return {
      source: "apps/orchestrator/src/prompts/system.md",
      ownership: "shared",
      editable: false,
      content_hash: promptHash(standing),
      content: wrapEvidence({ source: "guidelines", body: standing }),
    };
  },
};

export const studioGetAgentContext: StudioTool = {
  name: "studio_get_agent_context",
  schema: functionSchema(
    "studio_get_agent_context",
    "Inspect current prompt sources for one source-guild agent. The first 500 words of each standing task are already in the Studio system prompt. Use this tool for the remainder of a truncated task, the full task, memory, state, config, or effective_prompt (the exact opening system message the next run would receive, with task embeds inlined). Pass agent_id or name.",
    {
      agent_id: { type: "string", description: "Source-guild agent id or name. Required." },
      sections: {
        type: "array",
        items: { type: "string" },
        description: "Any of task, memory, state, config, effective_prompt, effective_prompt_headers. Defaults to task.",
      },
      cursor: { type: "string" },
    },
    ["agent_id"],
  ),
  async handler(ctx, args) {
    const agent = await resolveHandle(ctx, studioAgentHandleFromArgs(args) || undefined);
    const requested = Array.isArray(args.sections)
      ? args.sections.map((item) => String(item))
      : [...STUDIO_DEFAULT_CONTEXT_SECTIONS];
    const want = new Set(requested);
    const cursor = args.cursor;
    const actor = operatorContext(ctx.orgId, String(ctx.user.id), String(ctx.user.name ?? "operator"), {
      guildId: ctx.sourceGuildId,
      agentId: agent.id,
    });
    const task = await getAgentTask(ctx.db, ctx.orgId, agent.id);
    const memory = await getMemoryRow(ctx.artifacts, actor, agent.id);
    // state and effective_prompt read the same projection; take it once.
    let statePreview: ReturnType<typeof previewCurrentState> | null = null;
    const currentState = () => (statePreview ??= previewCurrentState(ctx.preview, agent));
    const result: Record<string, unknown> = {
      agent_id: agent.id,
      name: agent.name,
      focus: agent.focus,
    };
    if (want.has("task") && task) {
      const sliced = sliceStudioBytes(task.content_text ?? "", cursor);
      result.task = {
        display_path: displayPathFor({
          orgId: ctx.orgId,
          level: "agent",
          ownerId: agent.id,
          kind: "task",
          path: "",
          key: "task.md",
        }),
        version: task.version,
        content_hash: task.content_hash,
        has_embeds: collectTaskEmbeds(task.content_text ?? "").length > 0,
        ownership: "operator-owned",
        editable: true,
        content: wrapEvidence({ source: "task", coordinates: { version: task.version }, body: sliced.text }),
        ...(sliced.next_cursor ? { next_cursor: sliced.next_cursor } : {}),
        ...(sliced.truncated ? { truncated: true } : {}),
      };
    }
    if (want.has("memory") && memory) {
      const sliced = sliceStudioBytes(memory.content_text ?? "", want.has("task") ? 0 : cursor);
      result.memory = {
        version: memory.version,
        content_hash: memory.content_hash,
        ownership: "agent-owned",
        editable: true,
        content: wrapEvidence({ source: "memory", body: sliced.text }),
        ...(sliced.next_cursor ? { next_cursor: sliced.next_cursor } : {}),
        ...(sliced.truncated ? { truncated: true } : {}),
      };
    }
    if (want.has("state")) {
      const preview = await currentState();
      const sliced = sliceStudioBytes(JSON.stringify(preview.state, null, 2), want.has("task") || want.has("memory") ? 0 : cursor);
      result.state = {
        ownership: "derived",
        editable: false,
        projected_at: preview.projected_at,
        content: wrapEvidence({ source: "state", body: sliced.text }),
        ...(sliced.next_cursor ? { next_cursor: sliced.next_cursor } : {}),
        ...(sliced.truncated ? { truncated: true } : {}),
      };
    }
    if (want.has("config")) {
      result.config = agent.config;
    }
    if (want.has("effective_prompt")) {
      const standing = hydrateStanding({
        systemPath: ctx.notesSystemPath,
        agentName: agent.name,
        agentId: agent.id,
      });
      let effectiveTask = task?.content_text ?? "";
      let embedWarning: string | null = null;
      try {
        effectiveTask = await inlineTaskEmbeds(embedSource(ctx.artifacts), taskEmbedActor(ctx.orgId, agent), effectiveTask);
      } catch (error) {
        embedWarning = error instanceof Error ? error.message : "embed preflight failed";
      }
      const preview = await currentState();
      const tools = await projectOfferedToolSchemas(ctx.preview, agent);
      const memoryText = await readStoredMemory(ctx.artifacts, actor, agent.id);
      const memoryEnabled = memoryOf(jsonObj(agent.config));
      const composed = composeAgentSystemPrompt(
        standing,
        effectiveTask,
        preview.state,
        memoryText,
        memoryEnabled,
        memoryEnabled && schemasOffer(tools.schemas, "memory_write"),
      );
      const sliced = sliceStudioBytes(composed, want.size === 1 ? cursor : 0);
      result.effective_prompt = {
        ownership: "derived",
        editable: false,
        hash: promptHash(composed),
        task_hash: promptHash(effectiveTask),
        memory_hash: promptHash(memoryText),
        projected_at: preview.projected_at,
        ...(embedWarning ? { embed_warning: embedWarning } : {}),
        content: wrapEvidence({ source: "effective_prompt", coordinates: { agent_id: agent.id }, body: sliced.text }),
        ...(sliced.next_cursor ? { next_cursor: sliced.next_cursor } : {}),
        ...(sliced.truncated ? { truncated: true } : {}),
      };
    }
    if (want.has("effective_prompt_headers")) {
      result.effective_prompt_headers = [
        { section: "guidelines", ownership: "shared", editable: false },
        { section: "task", ownership: "operator-owned", editable: true, version: task?.version, content_hash: task?.content_hash },
        { section: "state", ownership: "derived", editable: false },
        { section: "memory", ownership: "agent-owned", editable: true, version: memory?.version },
      ];
    }
    return fitStudioPayload(result);
  },
};

export const studioListRoutines: StudioTool = {
  name: "studio_list_routines",
  schema: functionSchema(
    "studio_list_routines",
    "Inspect schedules and instructions for the source guild, or one agent when agent_id is set.",
    {
      agent_id: { type: "string" },
      paused: { type: "boolean" },
      cursor: { type: "string" },
      limit: { type: "integer" },
    },
    [],
  ),
  async handler(ctx, args) {
    const limit = clampLimit(args.limit, STUDIO_DEFAULT_LIMIT, 100);
    const offset = cursorOffset(args.cursor);
    let rows: AgentScheduleRow[];
    if (studioAgentHandleFromArgs(args)) {
      const agent = await resolveHandle(ctx, studioAgentHandleFromArgs(args) || undefined);
      rows = await listSchedules(ctx.db, agent.id);
    } else {
      rows = await listSchedulesForGuild(ctx.db, ctx.sourceGuildId);
    }
    const filtered = rows.filter((row) => {
      if (args.paused === undefined) return true;
      return Boolean(row.paused) === Boolean(args.paused);
    });
    const slice = filtered.slice(offset, offset + limit);
    const stats = await routineRunStats(ctx.db, slice.map((row) => row.id));
    const routines = [];
    for (const row of slice) {
      const mine = stats.get(row.id);
      routines.push({
        ...scheduleItem(row),
        run_count: mine?.count ?? 0,
        latest_run: mine ? runHeader(mine.latest) : null,
        instruction: wrapEvidence({
          source: "routine",
          coordinates: { schedule_id: row.id },
          body: String(row.instruction ?? ""),
        }),
      });
    }
    return {
      routines,
      next_cursor: offset + slice.length < filtered.length ? String(offset + slice.length) : null,
    };
  },
};

export const studioListRuns: StudioTool = {
  name: "studio_list_runs",
  schema: functionSchema(
    "studio_list_runs",
    "Find behavioral evidence without loading transcripts. kind is direct, group, or schedule; schedule_id lists the runs one routine produced.",
    {
      agent_id: { type: "string" },
      kind: { type: "string" },
      status: { type: "string" },
      error_only: { type: "boolean" },
      task_prompt_hash: { type: "string" },
      schedule_id: { type: "string", description: "Only runs woken by this routine." },
      cursor: { type: "string" },
      limit: { type: "integer" },
    },
    [],
  ),
  async handler(ctx, args) {
    const agent = await resolveHandle(ctx, studioAgentHandleFromArgs(args) || undefined);
    const limit = clampLimit(args.limit, STUDIO_DEFAULT_LIMIT, STUDIO_RUN_LIST_MAX);
    const offset = cursorOffset(args.cursor);
    // One row past the page says whether another page follows.
    const rows = await listRunHeaders(ctx.db, agent.id, {
      kind: argString(args, "kind"),
      status: argString(args, "status"),
      taskPromptHash: argString(args, "task_prompt_hash"),
      scheduleId: argString(args, "schedule_id"),
      errorOnly: args.error_only === true,
      limit: limit + 1,
      offset,
    });
    const slice = rows.slice(0, limit);
    return {
      runs: slice.map((row) => ({
        ...runHeader(row),
        errors: row.errors,
        task_source: row.metadata.task_source ?? null,
      })),
      next_cursor: rows.length > limit ? String(offset + limit) : null,
    };
  },
};

/** The assistant messages of `messages` that called `toolName`, and those calls' results. */
function callsOfTool(messages: MessageRow[], toolName: string): MessageRow[] {
  const callIds = new Set<string>();
  return messages.filter(({ payload }) => {
    if (payload.role === "assistant") {
      const mine = (payload.tool_calls ?? []).filter((call) => call.function.name === toolName);
      for (const call of mine) callIds.add(call.id);
      return mine.length > 0;
    }
    return payload.role === "tool" && callIds.has(payload.tool_call_id);
  });
}

export const studioGetRun: StudioTool = {
  name: "studio_get_run",
  schema: functionSchema(
    "studio_get_run",
    "Read exact historical evidence for a source-guild run. seq_start and seq_end bound the message window. tool_name keeps only the assistant turns that requested that tool and their tool results, for example memory_write or note_write.",
    {
      run_id: { type: "string" },
      seq_start: { type: "integer" },
      seq_end: { type: "integer" },
      tool_name: { type: "string", description: "Only the turns that called this tool, and their results." },
    },
    ["run_id"],
  ),
  async handler(ctx, args) {
    const runId = argString(args, "run_id");
    const run = await getRun(ctx.db, runId);
    if (!run) {
      throw new StudioUnprocessableError("run not found");
    }
    const agent = await getAgent(ctx.db, String(run.agent_id));
    if (!agent || agent.guild_id !== ctx.sourceGuildId) {
      throw new StudioUnprocessableError("run is not in the source guild");
    }
    const seqStart = argInteger(args, "seq_start", 0);
    const seqEnd = argInteger(args, "seq_end", 10_000);
    const toolName = argString(args, "tool_name");
    let messages = (await listMessages(ctx.db, runId)).filter((row) => row.seq >= seqStart && row.seq <= seqEnd);
    if (toolName) {
      messages = callsOfTool(messages, toolName);
    }
    const capped = messages.map((row) => {
      const [cut, truncated] = capBytes(row.payload.content, STUDIO_TOOL_RESULT_MAX_BYTES);
      return { seq: row.seq, payload: { ...row.payload, content: cut }, metadata: row.metadata, truncated };
    });
    return {
      run: {
        id: run.id,
        agent_id: run.agent_id,
        kind: run.kind,
        status: run.status,
        task_prompt_hash: run.task_prompt_hash,
        schedule_id: run.schedule_id,
        metadata: run.metadata,
      },
      ...(toolName ? { tool_name: toolName, matched: capped.length } : {}),
      messages: capped.map((row) => ({
        ...row,
        payload: {
          ...row.payload,
          content: wrapEvidence({
            source: "run_message",
            coordinates: { run_id: runId, seq: row.seq },
            body: row.payload.content,
          }),
        },
      })),
    };
  },
};

export const studioListGroupMessages: StudioTool = {
  name: "studio_list_group_messages",
  schema: functionSchema(
    "studio_list_group_messages",
    "Inspect bounded public guild history.",
    {
      cursor: { type: "string" },
      limit: { type: "integer" },
      author_type: { type: "string" },
      author_handle: { type: "string" },
    },
    [],
  ),
  async handler(ctx, args) {
    const limit = clampLimit(args.limit, STUDIO_DEFAULT_LIMIT, STUDIO_GROUP_LIST_MAX);
    const offset = cursorOffset(args.cursor);
    let rows = await listGroupMessages(ctx.db, ctx.sourceGuildId);
    if (argString(args, "author_type")) {
      rows = rows.filter((row) => row.author_type === args.author_type);
    }
    if (argString(args, "author_handle")) {
      rows = rows.filter((row) => row.author_agent_id === args.author_handle || row.author_name === args.author_handle);
    }
    const slice = rows.slice(offset, offset + limit);
    return {
      messages: slice.map((row) => ({
        seq: row.seq,
        author_type: row.author_type,
        author_name: row.author_name,
        author_agent_id: row.author_agent_id,
        created_at: row.created_at,
        content: wrapEvidence({
          source: "group_message",
          coordinates: { seq: row.seq },
          body: String(row.content ?? ""),
        }),
      })),
      next_cursor: offset + slice.length < rows.length ? String(offset + slice.length) : null,
    };
  },
};

export const studioListTaskRevisions: StudioTool = {
  name: "studio_list_task_revisions",
  schema: functionSchema(
    "studio_list_task_revisions",
    "Inspect prior operator task versions.",
    { agent_id: { type: "string" }, cursor: { type: "string" }, limit: { type: "integer" } },
    [],
  ),
  async handler(ctx, args) {
    const agent = await resolveHandle(ctx, studioAgentHandleFromArgs(args) || undefined);
    const limit = clampLimit(args.limit, STUDIO_DEFAULT_LIMIT, STUDIO_REVISION_LIST_MAX);
    const offset = cursorOffset(args.cursor);
    const rows = await listAgentTaskRevisions(ctx.db, ctx.orgId, agent.id);
    const slice = rows.slice(offset, offset + limit);
    return {
      revisions: slice.map((row) => ({
        version: row.version,
        replaced_at: row.replaced_at,
        replaced_by_name: row.replaced_by_name,
        content_hash: hashArtifactContent(row.content),
        content: wrapEvidence({
          source: "task_revision",
          coordinates: { agent_id: agent.id, version: row.version },
          body: capBytes(row.content, STUDIO_TOOL_RESULT_MAX_BYTES)[0],
        }),
      })),
      next_cursor: offset + slice.length < rows.length ? String(offset + slice.length) : null,
    };
  },
};

async function memoryTimelineFor(ctx: StudioToolContext, agent: Pick<AgentRow, "id">): Promise<MemoryTimelineEntry[]> {
  const actor = operatorContext(ctx.orgId, String(ctx.user.id), String(ctx.user.name ?? "operator"), {
    guildId: ctx.sourceGuildId,
    agentId: agent.id,
  });
  const live = await getMemoryRow(ctx.artifacts, actor, agent.id);
  const revisions = await listRevisions(ctx.artifacts, actor, agent.id);
  return buildMemoryTimeline({ live: { content: live?.content_text ?? "" }, revisions });
}

function timelineHeader(entry: MemoryTimelineEntry): Record<string, unknown> {
  return {
    version_index: entry.index,
    revision_id: entry.revision_id,
    live: entry.revision_id === null,
    archive_display_path: entry.archive_display_path,
    written_at: entry.written_at,
    actor: entry.actor,
    run_id: entry.run_id,
    stats: entry.stats,
    content_hash: entry.content_hash,
  };
}

export const studioListMemoryRevisions: StudioTool = {
  name: "studio_list_memory_revisions",
  schema: functionSchema(
    "studio_list_memory_revisions",
    "List the versions an agent's Memory has held, newest first: who wrote each version (a run id, a user, or the agent), when, and line counts. Content is not included; read one version with studio_get_memory_version.",
    { agent_id: { type: "string" }, cursor: { type: "string" }, limit: { type: "integer" } },
    [],
  ),
  async handler(ctx, args) {
    const agent = await resolveHandle(ctx, studioAgentHandleFromArgs(args) || undefined);
    const limit = clampLimit(args.limit, STUDIO_DEFAULT_LIMIT, STUDIO_REVISION_LIST_MAX);
    const offset = cursorOffset(args.cursor);
    const entries = await memoryTimelineFor(ctx, agent);
    const slice = entries.slice(offset, offset + limit);
    return {
      agent_id: agent.id,
      versions: slice.map(timelineHeader),
      next_cursor: offset + slice.length < entries.length ? String(offset + slice.length) : null,
    };
  },
};

export const studioGetMemoryVersion: StudioTool = {
  name: "studio_get_memory_version",
  schema: functionSchema(
    "studio_get_memory_version",
    "Read one version of an agent's Memory by revision_id or version_index from studio_list_memory_revisions (omit both for the live version), with the line diff against the previous version.",
    {
      agent_id: { type: "string", description: "Source-guild agent id or name. Required." },
      revision_id: { type: "string", description: "Revision id of the version to read. Omit for the live version." },
      version_index: { type: "integer", description: "Version index from studio_list_memory_revisions." },
      cursor: { type: "string" },
    },
    ["agent_id"],
  ),
  async handler(ctx, args) {
    const agent = await resolveHandle(ctx, studioAgentHandleFromArgs(args) || undefined);
    const entries = await memoryTimelineFor(ctx, agent);
    const revisionId = argString(args, "revision_id");
    const index = typeof args.version_index === "number" ? args.version_index : null;
    const entry = revisionId
      ? entries.find((item) => item.revision_id === revisionId)
      : index !== null
        ? entries.find((item) => item.index === index)
        : entries.find((item) => item.revision_id === null);
    if (!entry) {
      throw new StudioUnprocessableError("memory version not found");
    }
    const sliced = sliceStudioBytes(entry.content, args.cursor);
    const diff = entry.previous_content === null ? "" : memoryDiffText(entry.previous_content, entry.content);
    return {
      agent_id: agent.id,
      ...timelineHeader(entry),
      content: wrapEvidence({
        source: "memory_version",
        coordinates: { agent_id: agent.id, revision_id: entry.revision_id, version_index: entry.index },
        body: sliced.text,
      }),
      ...(sliced.next_cursor ? { next_cursor: sliced.next_cursor } : {}),
      ...(sliced.truncated ? { truncated: true } : {}),
      diff_from_previous: diff
        ? wrapEvidence({
            source: "memory_version_diff",
            coordinates: { agent_id: agent.id, version_index: entry.index },
            body: capBytes(diff, STUDIO_TOOL_RESULT_MAX_BYTES)[0],
          })
        : null,
    };
  },
};

export const studioFindArtifacts: StudioTool = {
  name: "studio_find_artifacts",
  schema: functionSchema(
    "studio_find_artifacts",
    "Search notes relevant to the source guild.",
    {
      query: { type: "string", description: "words to find in note titles and bodies" },
      level: { type: "string" },
      cursor: { type: "string" },
      limit: { type: "integer" },
    },
    [],
  ),
  async handler(ctx, args) {
    const limit = clampLimit(args.limit, STUDIO_DEFAULT_LIMIT, STUDIO_ARTIFACT_LIST_MAX);
    const actor = operatorContext(ctx.orgId, String(ctx.user.id), String(ctx.user.name ?? "operator"), {
      guildId: ctx.sourceGuildId,
    });
    const findArgs: {
      query: string;
      level?: "agent" | "guild" | "org";
      limit: number;
    } = {
      query: argString(args, "query"),
      limit: STUDIO_ARTIFACT_LIST_MAX,
    };
    const level = argString(args, "level");
    if (level === "agent" || level === "guild" || level === "org") findArgs.level = level;
    const found = await findNotes(ctx.artifacts, actor, findArgs);
    const allowed = [];
    for (const item of found.notes) {
      if (await studioReachesPath(ctx, String(item.display_path ?? ""))) allowed.push(item);
    }
    const offset = cursorOffset(args.cursor);
    const slice = allowed.slice(offset, offset + limit);
    return {
      artifacts: slice.map((item) => ({
        display_path: item.display_path,
        level: item.level,
        kind: item.kind,
        owner_id: item.owner_id ?? item.agent_id ?? item.guild_id,
        version: item.version,
        title: item.title,
        trust: "untrusted",
      })),
      next_cursor: offset + slice.length < allowed.length ? String(offset + slice.length) : null,
    };
  },
};

export const studioGetArtifact: StudioTool = {
  name: "studio_get_artifact",
  schema: functionSchema(
    "studio_get_artifact",
    "Read one artifact by a display path returned from an authorized Studio result.",
    { display_path: { type: "string" }, cursor: { type: "string" } },
    ["display_path"],
  ),
  async handler(ctx, args) {
    const displayPath = argString(args, "display_path");
    let parsed;
    try {
      parsed = parseDisplayPath(displayPath);
    } catch (error) {
      if (error instanceof ArtifactError) {
        throw new StudioUnprocessableError(error.message);
      }
      throw error;
    }
    if (parsed.orgId !== ctx.orgId) {
      throw new StudioUnprocessableError("artifact is not in this organisation");
    }
    if (parsed.kind === "collection") {
      throw new StudioUnprocessableError(`${parsed.collectionName} is a table; read it with studio_get_collection`);
    }
    if (!(await studioReachesParsed(ctx, parsed))) {
      throw new StudioUnprocessableError("artifact is not in the source guild or the organisation's shared files");
    }
    const actor = operatorContext(ctx.orgId, String(ctx.user.id), String(ctx.user.name ?? "operator"), {
      guildId: ctx.sourceGuildId,
    });
    let loaded;
    try {
      loaded = await getByDisplayPath(ctx.artifacts, actor, displayPath);
    } catch (error) {
      if (error instanceof ArtifactError) {
        throw new StudioUnprocessableError(error.message);
      }
      throw error;
    }
    if (!loaded.row) {
      throw new StudioUnprocessableError("artifact not found");
    }
    const text = loaded.row.content_text ?? JSON.stringify(loaded.row.content_json ?? {});
    const offset = cursorOffset(args.cursor);
    const encoded = Buffer.from(text, "utf8");
    const slice = encoded.subarray(offset, offset + STUDIO_TOOL_RESULT_MAX_BYTES).toString("utf8");
    return {
      display_path: displayPath,
      kind: loaded.row.kind,
      title: loaded.row.title,
      version: loaded.row.version,
      editable: loaded.row.kind === "note",
      content: wrapEvidence({
        source: "artifact",
        coordinates: { display_path: displayPath, version: loaded.row.version },
        body: slice,
      }),
      next_cursor: offset + STUDIO_TOOL_RESULT_MAX_BYTES < encoded.length ? String(offset + STUDIO_TOOL_RESULT_MAX_BYTES) : null,
    };
  },
};

export const studioListFileChanges: StudioTool = {
  name: "studio_list_file_changes",
  schema: functionSchema(
    "studio_list_file_changes",
    "List who changed one file and when, newest first: notes, objects, scripts, memory, and standing tasks by display path. A run-written change carries the run id and the tool call that wrote it; read that run with studio_get_run.",
    {
      display_path: { type: "string", description: "Display path from an authorized Studio result. Required." },
      cursor: { type: "string" },
      limit: { type: "integer" },
    },
    ["display_path"],
  ),
  async handler(ctx, args) {
    const displayPath = argString(args, "display_path");
    let parsed;
    try {
      parsed = parseDisplayPath(displayPath);
    } catch (error) {
      if (error instanceof ArtifactError) {
        throw new StudioUnprocessableError(error.message);
      }
      throw error;
    }
    if (parsed.orgId !== ctx.orgId) {
      throw new StudioUnprocessableError("path is not in this organisation");
    }
    if (!(await studioReachesParsed(ctx, parsed))) {
      throw new StudioUnprocessableError("path is not in the source guild or the organisation's shared files");
    }
    const limit = clampLimit(args.limit, STUDIO_DEFAULT_LIMIT, STUDIO_REVISION_LIST_MAX);
    const offset = cursorOffset(args.cursor);
    const rows = await listFileChanges(ctx.db, ctx.orgId, displayPath);
    const slice = rows.slice(offset, offset + limit);
    return {
      display_path: displayPath,
      changes: slice.map((change) => ({
        id: change.id,
        operation: change.operation,
        version: change.version,
        at: change.created_at,
        actor: change.actor,
        run: change.run
          ? { id: change.run.id, agent_id: change.run.agent_id, kind: change.run.kind, status: change.run.status, schedule_id: change.run.schedule_id }
          : null,
        tool: change.tool,
        studio: change.studio,
      })),
      next_cursor: offset + slice.length < rows.length ? String(offset + slice.length) : null,
    };
  },
};

export const studioGetScript: StudioTool = {
  name: "studio_get_script",
  schema: functionSchema(
    "studio_get_script",
    "Read the source of one script owned by a source-guild agent. Script names come from the State projection or studio_get_agent_access.",
    {
      agent_id: { type: "string", description: "Source-guild agent id or name. Required." },
      name: { type: "string", description: "Script name. Required." },
      cursor: { type: "string" },
    },
    ["agent_id", "name"],
  ),
  async handler(ctx, args) {
    const agent = await resolveHandle(ctx, studioAgentHandleFromArgs(args) || undefined);
    let script: Record<string, unknown>;
    try {
      script = await ctx.preview.scripts.get(agent.id, argString(args, "name"));
    } catch (error) {
      if (error instanceof ScriptError) {
        throw new StudioUnprocessableError(error.message);
      }
      throw error;
    }
    const sliced = sliceStudioBytes(String(script.source ?? ""), args.cursor);
    return {
      agent_id: agent.id,
      name: script.name,
      description: script.description,
      parameters: script.parameters,
      source_hash: script.source_hash,
      ownership: "agent-owned",
      editable: false,
      content: wrapEvidence({
        source: "script",
        coordinates: { agent_id: agent.id, name: String(script.name), source_hash: String(script.source_hash ?? "") },
        body: sliced.text,
      }),
      ...(sliced.next_cursor ? { next_cursor: sliced.next_cursor } : {}),
      ...(sliced.truncated ? { truncated: true } : {}),
    };
  },
};

async function liveGrantedConnectionIds(ctx: StudioToolContext): Promise<Set<string>> {
  const live = await getStudioSession(ctx.db, String(ctx.session.id));
  return new Set(grantedConnectionIds(live ?? ctx.session));
}

export const studioGetAgentAccess: StudioTool = {
  name: "studio_get_agent_access",
  schema: functionSchema(
    "studio_get_agent_access",
    "Inspect what one source-guild agent is offered at run start: native tools, scripts, secret names, and MCP connections with their listed tools. Withheld lists name what the agent could be offered but is not. Each connection says whether this Studio session may read through it (studio_granted).",
    {
      agent_id: { type: "string", description: "Source-guild agent id or name. Required." },
    },
    ["agent_id"],
  ),
  async handler(ctx, args) {
    const agent = await resolveHandle(ctx, studioAgentHandleFromArgs(args) || undefined);
    const access = await projectAgentAccess(ctx.preview, agent);
    const granted = await liveGrantedConnectionIds(ctx);
    return truncatePayload({
      agent_id: agent.id,
      name: agent.name,
      native_tools: access.native_tools,
      withheld_native_tools: NATIVE_TOOLS.filter((name) => !access.native_tools.includes(name)),
      scripts: access.scripts,
      secrets: access.secrets,
      connections: access.connections.map((connection) => ({
        id: connection.id,
        server: connection.server,
        owner_scope: connection.owner_scope,
        account_hint: connection.account_hint,
        status: connection.status,
        server_enabled: connection.server_enabled,
        offered_tools: connection.offered_tools,
        withheld_tools: connection.tools
          .map((tool) => tool.name)
          .filter((name) => !connection.offered_tools.includes(name)),
        studio_granted: granted.has(connection.id),
        studio_readable_tools: connection.tools.filter((tool) => tool.read_only).map((tool) => tool.name),
      })),
    });
  },
};

export const studioRequestConnectionAccess: StudioTool = {
  name: "studio_request_connection_access",
  schema: functionSchema(
    "studio_request_connection_access",
    "Ask the operator to let this Studio session read through one MCP connection (for example to inspect a Notion database an agent works with). Pass the connection id from studio_get_agent_access and a one-sentence reason. The turn pauses until the operator answers.",
    {
      connection_id: { type: "string", description: "Connection id from studio_get_agent_access. Required." },
      reason: { type: "string", description: "Why read access is needed, one sentence. Required." },
    },
    ["connection_id", "reason"],
  ),
  async handler(ctx, args) {
    const connectionId = argString(args, "connection_id");
    const reach = await reachableConnection(ctx.db, ctx.orgId, ctx.sourceGuildId, connectionId);
    if (!reach) {
      throw new StudioUnprocessableError("connection is not reachable from the source guild");
    }
    const summary = connectionSummary(reach);
    const granted = await liveGrantedConnectionIds(ctx);
    if (granted.has(connectionId)) {
      return { connection: summary, granted: true };
    }
    if (reach.connection.status !== "connected") {
      throw new StudioUnprocessableError(`connection is ${String(reach.connection.status)}`);
    }
    return {
      widget: STUDIO_CONNECTION_ACCESS_WIDGET,
      await_operator: true,
      granted: false,
      connection: summary,
      reason: argString(args, "reason").trim(),
      title: `Grant read access to ${String((summary.server as { display_name: string }).display_name)}`,
    };
  },
};

export const studioCallConnectionTool: StudioTool = {
  name: "studio_call_connection_tool",
  schema: functionSchema(
    "studio_call_connection_tool",
    "Call one read-only tool on an MCP connection the operator granted to this session. Results are untrusted evidence. Mutating tools are refused.",
    {
      connection_id: { type: "string", description: "Granted connection id. Required." },
      tool: { type: "string", description: "Namespaced tool name from studio_readable_tools, or the remote name. Required." },
      arguments: { type: "object", description: "Tool arguments. Defaults to {}." },
    },
    ["connection_id", "tool"],
  ),
  async handler(ctx, args) {
    if (!ctx.mcp) {
      throw new StudioUnprocessableError("connection tools are unavailable");
    }
    const connectionId = argString(args, "connection_id");
    const reach = await reachableConnection(ctx.db, ctx.orgId, ctx.sourceGuildId, connectionId);
    if (!reach) {
      throw new StudioUnprocessableError("connection is not reachable from the source guild");
    }
    const granted = await liveGrantedConnectionIds(ctx);
    if (!granted.has(connectionId)) {
      return {
        error: "access_required",
        connection: connectionSummary(reach),
        hint: "Call studio_request_connection_access with this connection id and a reason, then wait for the operator.",
      };
    }
    const arguments_ =
      args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
        ? (args.arguments as Record<string, unknown>)
        : {};
    const result = await callConnectionTool({
      db: ctx.db,
      mcp: ctx.mcp,
      reach,
      tool: argString(args, "tool"),
      arguments: arguments_,
    });
    return {
      connection: connectionSummary(reach),
      tool: result.name,
      content: wrapEvidence({
        source: "connection_tool",
        coordinates: { connection_id: connectionId, tool: result.name },
        body: result.content,
      }),
      ...(result.truncated ? { truncated: true } : {}),
    };
  },
};

export const studioCreateTaskDraft: StudioTool = {
  name: "studio_create_task_draft",
  schema: functionSchema(
    "studio_create_task_draft",
    "Create or replace a standing task draft for a source-guild agent, named by agent_id; the operator's inspector selection plays no part. Drafts for several agents may be created in one turn. Supply complete proposed content.",
    {
      agent_id: { type: "string", description: "Source-guild agent id or name from the roster. Required." },
      proposed_content: {
        type: "string",
        description:
          "Complete standing task in the Task shape: an opening line, then Inputs, Work, Outputs, and Files as headings with bullets. Shared files that must enter every run use ![[display-path]] from studio_find_artifacts / studio_get_artifact. A bare filename does not inline.",
      },
      rationale: { type: "string" },
      evidence_refs: { type: "array" },
      risks: { type: "array", items: { type: "string" } },
    },
    ["agent_id", "proposed_content", "rationale"],
  ),
  async handler(ctx, args) {
    return ctx.drafts.createFromTool(ctx, args);
  },
};

function editScope(ctx: StudioToolContext): EditScope {
  return {
    orgId: ctx.orgId,
    sourceGuildId: ctx.sourceGuildId,
    sessionId: String(ctx.session.id),
    user: ctx.user,
    db: ctx.db,
    artifacts: ctx.artifacts,
    schedules: ctx.schedules,
  };
}

function baseVersionArg(args: Record<string, unknown>): number | null {
  return typeof args.base_version === "number" && Number.isInteger(args.base_version) ? args.base_version : null;
}

export const studioGetGuild: StudioTool = {
  name: "studio_get_guild",
  schema: functionSchema(
    "studio_get_guild",
    "Read the source guild's live about (short, one line) and description (long) in full. The system message holds the text from session start, capped; this tool returns the current text.",
    {},
    [],
  ),
  async handler(ctx) {
    const base = await loadGuildBase(editScope(ctx));
    if (base.kind !== "guild") {
      throw new StudioUnprocessableError("source guild not found");
    }
    return {
      guild_id: base.guildId,
      name: base.guildName,
      ownership: "operator-owned",
      editable: true,
      about_max_chars: ABOUT_MAX,
      description_max_chars: DESCRIPTION_MAX,
      about: wrapEvidence({ source: "guild_about", coordinates: { guild_id: base.guildId }, body: base.text.about }),
      description: wrapEvidence({
        source: "guild_description",
        coordinates: { guild_id: base.guildId },
        body: base.text.description,
      }),
    };
  },
};

export const studioListGuilds: StudioTool = {
  name: "studio_list_guilds",
  schema: functionSchema(
    "studio_list_guilds",
    "Read the organisation's other guilds that the operator can see: each one's name, about (short), and description (long). Their agents, files, and tables stay out of reach; their shared output reaches this guild through organisation tables and notes.",
    { cursor: { type: "string" }, limit: { type: "integer" } },
    [],
  ),
  async handler(ctx, args) {
    const limit = clampLimit(args.limit, STUDIO_DEFAULT_LIMIT, STUDIO_GROUP_LIST_MAX);
    const offset = cursorOffset(args.cursor);
    const others = (await listGuildsForUser(ctx.db, ctx.orgId, String(ctx.user.id))).filter(
      (row) => row.id !== String(ctx.sourceGuildId),
    );
    // A page ends at the limit or where the next guild would pass the byte cap.
    const guilds: Array<Record<string, unknown>> = [];
    let bytes = 0;
    for (const row of others.slice(offset, offset + limit)) {
      const item = {
        guild_id: row.id,
        name: wrapEvidence({ source: "guild_name", coordinates: { guild_id: row.id }, body: String(row.name ?? "") }),
        about: wrapEvidence({ source: "guild_about", coordinates: { guild_id: row.id }, body: String(row.about ?? "") }),
        description: wrapEvidence({
          source: "guild_description",
          coordinates: { guild_id: row.id },
          body: String(row.description ?? ""),
        }),
      };
      const size = Buffer.byteLength(JSON.stringify(item), "utf8");
      if (guilds.length && bytes + size > STUDIO_TOTAL_RETURNED_BYTES / 2) break;
      guilds.push(item);
      bytes += size;
    }
    const next = offset + guilds.length;
    return truncatePayload({
      guilds,
      editable: false,
      next_cursor: next < others.length ? String(next) : null,
    });
  },
};

export const studioEditMemory: StudioTool = {
  name: "studio_edit_memory",
  schema: functionSchema(
    "studio_edit_memory",
    "Propose a complete replacement of one source-guild agent's Memory. Nothing is written: the turn pauses and the operator applies or declines. Read the live Memory first and pass its version as base_version.",
    {
      agent_id: { type: "string", description: "Source-guild agent id or name. Required." },
      content: { type: "string", description: "Complete proposed Memory, not a description of changes. Required." },
      base_version: { type: "integer", description: "Memory version the proposal was built from. Required." },
      reason: { type: "string", description: "Why this edit, one or two sentences, citing evidence. Required." },
    },
    ["agent_id", "content", "base_version", "reason"],
  ),
  async handler(ctx, args) {
    const agent = await resolveHandle(ctx, studioAgentHandleFromArgs(args) || undefined);
    const base = await loadMemoryBase(editScope(ctx), agent);
    return editRequest(base, args, baseVersionArg(args));
  },
};

const NOTE_LEVEL = {
  type: "string",
  enum: ["agent", "guild", "org"],
  description:
    "create: agent is one agent's own file, guild is read by the source guild's agents, org is read across the organisation.",
};

async function noteAgentId(ctx: StudioToolContext, args: Record<string, unknown>): Promise<string | null> {
  const handle = studioAgentHandleFromArgs(args);
  if (argString(args, "level") !== "agent" || !handle) {
    return null;
  }
  return String((await resolveHandle(ctx, handle)).id);
}

export const studioEditNote: StudioTool = {
  name: "studio_edit_note",
  schema: functionSchema(
    "studio_edit_note",
    "Propose a change to one note of the source guild, one of its agents, or the organisation. Nothing is written: the turn pauses and the operator applies or declines. create: a new note at the narrowest level that holds every reader; search with studio_find_artifacts first and edit a note that fits instead; the result's target carries the display path to embed or name in a Task draft. edit: a complete replacement of an existing note's body. delete: applying fails while any Task embeds the note, so draft those Tasks first. edit and delete name the note by display_path and pass the version studio_get_artifact returned as base_version. Memory, Tasks, scripts, and records are not changed here.",
    {
      action: { type: "string", enum: ["create", "edit", "delete"], description: "Required." },
      display_path: { type: "string", description: "edit and delete: display path from studio_find_artifacts or studio_get_artifact." },
      base_version: { type: "integer", description: "edit and delete: the note version the proposal was built from." },
      level: NOTE_LEVEL,
      agent_id: { type: "string", description: "create at level agent: source-guild agent id or name." },
      key: { type: "string", description: "create: file name ending in .md, no folders, for example playbook.md." },
      title: { type: "string", description: "create: short title shown in Files." },
      content: { type: "string", description: "create and edit: the complete note body, not a description of changes." },
      reason: { type: "string", description: "Why this change, one or two sentences, citing evidence. Required." },
    },
    ["action", "reason"],
  ),
  async handler(ctx, args) {
    const action = editActionOf(args);
    if (action === "edit") {
      const base = await loadNoteBase(editScope(ctx), argString(args, "display_path"));
      return editRequest(base, args, baseVersionArg(args));
    }
    const agentId = action === "create" ? await noteAgentId(ctx, args) : null;
    return noteEditRequest(editScope(ctx), action, args, agentId);
  },
};

const ACCESS_SETTINGS = {
  type: "object",
  additionalProperties: { type: "string", enum: ["on", "off", "inherit"] },
};

export const studioEditAccess: StudioTool = {
  name: "studio_edit_access",
  schema: functionSchema(
    "studio_edit_access",
    "Propose what one source-guild agent is offered: native tools, whole connections, and single connection tools. Each entry sets the agent's own overlay: on, off, or inherit (drop the overlay and take the guild's setting). Entries left out stay as they are. Nothing is written: the turn pauses and the operator applies or declines. Read the agent with studio_get_agent_access first. The browser, coding, scripting, and memory switches are agent configuration, not access.",
    {
      agent_id: { type: "string", description: "Source-guild agent id or name. Required." },
      native_tools: {
        ...ACCESS_SETTINGS,
        description: "Native tool name to setting, from native_tools or withheld_native_tools.",
      },
      connections: {
        ...ACCESS_SETTINGS,
        description: "Connection id from studio_get_agent_access to setting: the whole connection for this agent.",
      },
      connection_tools: {
        ...ACCESS_SETTINGS,
        description: "Connection tool name from offered_tools or withheld_tools to setting.",
      },
      reason: { type: "string", description: "Why this change, one or two sentences, citing evidence. Required." },
    },
    ["agent_id", "reason"],
  ),
  async handler(ctx, args) {
    const agent = await resolveHandle(ctx, studioAgentHandleFromArgs(args) || undefined);
    return accessEditRequest(editScope(ctx), agent.id, args);
  },
};

export const studioEditGuild: StudioTool = {
  name: "studio_edit_guild",
  schema: functionSchema(
    "studio_edit_guild",
    `Propose new text for the source guild's about (short, at most ${ABOUT_MAX} characters), description (long, at most ${DESCRIPTION_MAX} characters), or both. A field left out keeps its live text. Nothing is written: the turn pauses and the operator applies or declines. Read the live text with studio_get_guild first.`,
    {
      about: { type: "string", description: "Complete proposed about line." },
      description: { type: "string", description: "Complete proposed description." },
      reason: { type: "string", description: "Why this edit, one or two sentences. Required." },
    },
    ["reason"],
  ),
  async handler(ctx, args) {
    const base = await loadGuildBase(editScope(ctx));
    return editRequest(base, args, null);
  },
};

const COLUMN_PROPERTIES = {
  name: { type: "string", description: "^[a-z][a-z0-9_]{0,63}$; id, created_at, updated_at, created_by, and updated_by are reserved." },
  type: { type: "string", enum: ["text", "number", "boolean", "datetime", "array"] },
  description: { type: "string", description: "What the value means and how agents should fill it. At most 1000 characters." },
  required: { type: "boolean" },
  unique: {
    type: "boolean",
    description: "Text or number only, at most one per table. A record_add that repeats the value merges into that record.",
  },
  values: {
    type: "array",
    items: { type: "string" },
    description: "Text or array only: the closed list of accepted values, such as a queue's state.",
  },
};

function columnsSchema(description: string): Record<string, unknown> {
  return {
    type: "array",
    description,
    items: {
      type: "object",
      properties: {
        ...COLUMN_PROPERTIES,
        rename_from: {
          type: "string",
          description: "The column's current name when this entry renames it; its values move to the new name.",
        },
      },
      required: ["name", "type", "description"],
      additionalProperties: false,
    },
  };
}

const ACCESS_SCHEMA = {
  type: "object",
  description: "Who in the source guild reaches the table. Only the entries given change.",
  properties: {
    guild: {
      type: "string",
      enum: ["read", "write", "none"],
      description: "The guild's row: the mode of every agent in the guild without a row of its own; none removes the guild's row.",
    },
    agents: {
      type: "array",
      items: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "Source-guild agent id or name." },
          mode: {
            type: "string",
            enum: ["read", "write", "none", "inherit"],
            description: "The agent's own row over the guild's: none keeps it out; inherit removes its own row.",
          },
        },
        required: ["agent_id", "mode"],
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

const TABLE_REASON = { type: "string", description: "Why this change, one or two sentences, citing evidence. Required." };

export const studioListCollections: StudioTool = {
  name: "studio_list_collections",
  schema: functionSchema(
    "studio_list_collections",
    "List the tables (collections) the source guild's agents can be given: the guild's own, then the organisation's. Each has owner, purpose, record count, column names, the source guild's access, and studio_can: edit_or_delete for the guild's own, add_columns_and_access for the organisation's.",
    {},
    [],
  ),
  async handler(ctx) {
    return { collections: await listTables(editScope(ctx)), trust: "untrusted" };
  },
};

export const studioGetCollection: StudioTool = {
  name: "studio_get_collection",
  schema: functionSchema(
    "studio_get_collection",
    "Read one table: purpose, full columns, record count, updated_at (pass it as base_updated_at to studio_edit_collection), the organisation's row, the source guild's row, each source-guild agent's row and resulting access, the rows of other guilds and their agents, and the latest records.",
    { collection: { type: "string", description: "Table name from studio_list_collections. Required." } },
    ["collection"],
  ),
  async handler(ctx, args) {
    return { ...(await readTable(editScope(ctx), argString(args, "collection"))), trust: "untrusted" };
  },
};

export const studioEditCollection: StudioTool = {
  name: "studio_edit_collection",
  schema: functionSchema(
    "studio_edit_collection",
    "Propose a change to one table of the source guild or the organisation. Nothing is written: the turn pauses and the operator applies or declines. create: a new table agents read and write with the record tools; check studio_list_collections first and reuse a table that fits. edit: on the source guild's own table, a new name, purpose, column list, or member access; on an organisation table, new columns added to the unchanged current ones, or source-guild access. Fields left out stay as they are. delete: one of the source guild's own tables with every record in it and its access list. edit and delete name the table by collection; read it with studio_get_collection first.",
    {
      action: { type: "string", enum: ["create", "edit", "delete"], description: "Required." },
      collection: { type: "string", description: "edit and delete: the table's current name." },
      base_updated_at: { type: "string", description: "edit: the updated_at studio_get_collection returned." },
      name: {
        type: "string",
        description:
          "create: ^[a-z][a-z0-9_-]{0,62}$, unique in the organisation. edit: the new name; Tasks, notes, and routines that name the old one must change too.",
      },
      purpose: { type: "string", description: "create and edit: one line, at most 400 characters: what one record is and who writes it." },
      columns: columnsSchema(
        "create: the typed columns, in display order; every record write is validated against them. edit: the complete column list replacing the current one; keep every column you do not mean to change, since a column left out is dropped from every record.",
      ),
      scope: {
        type: "string",
        enum: ["guild", "org"],
        description: "create: guild (default), the source guild owns the table and starts with the guild at write; org, an organisation table that starts with the organisation at read.",
      },
      access: ACCESS_SCHEMA,
      reason: TABLE_REASON,
    },
    ["action", "reason"],
  ),
  async handler(ctx, args) {
    return tableEditRequest(editScope(ctx), args);
  },
};

const ROUTINE_TIMING = {
  cron: {
    type: "string",
    description:
      "5-field UTC expression (minute hour day month weekday), for example '0 9 * * 1'; wake-ups at least 5 minutes apart. Pass cron or window, not both.",
  },
  window: {
    type: "object",
    description: "Random wake-ups inside a daily local-time window. Pass cron or window, not both.",
    properties: {
      timezone: { type: "string", description: "IANA name, for example Europe/Paris." },
      start: { type: "string", description: "HH:MM local time." },
      end: { type: "string", description: "HH:MM local time; earlier than start spans midnight." },
      max_wakes: { type: "integer", description: "Most wake-ups per window; gaps are at least 5 minutes." },
    },
    required: ["timezone", "start", "end", "max_wakes"],
    additionalProperties: false,
  },
};

const ROUTINE_TEXT = {
  description: { type: "string", description: "One-line label shown in the Routine tab, at most 400 characters." },
  instruction: {
    type: "string",
    description: "Short markdown the agent receives on each wake-up, at most 2000 characters: what this wake-up is for, not the agent's whole Task.",
  },
};

const ROUTINE_REASON = { type: "string", description: "Why this change, one or two sentences, citing evidence. Required." };

export const studioEditRoutine: StudioTool = {
  name: "studio_edit_routine",
  schema: functionSchema(
    "studio_edit_routine",
    "Propose a change to one routine of a source-guild agent. Nothing is written: the turn pauses and the operator applies or declines. create: a new routine that wakes one agent on a UTC cron or at random times inside a daily window; check studio_list_routines first and change a routine that fits instead. edit: a new timing, description, instruction, or paused state; fields left out stay as they are. delete: its past runs stay; propose pausing it instead when it may be needed again. edit and delete name the routine by schedule_id from studio_list_routines.",
    {
      action: { type: "string", enum: ["create", "edit", "delete"], description: "Required." },
      agent_id: { type: "string", description: "create: source-guild agent id or name." },
      schedule_id: { type: "string", description: "edit and delete: the routine's id from studio_list_routines." },
      ...ROUTINE_TIMING,
      ...ROUTINE_TEXT,
      paused: { type: "boolean", description: "create: true creates it paused. edit: true pauses it; false resumes it." },
      reason: ROUTINE_REASON,
    },
    ["action", "reason"],
  ),
  async handler(ctx, args) {
    const agentId = editActionOf(args) === "create" ? await routineAgentId(ctx, args) : null;
    return routineEditRequest(editScope(ctx), { args, agentId });
  },
};

async function routineAgentId(ctx: StudioToolContext, args: Record<string, unknown>): Promise<string> {
  return String((await resolveHandle(ctx, studioAgentHandleFromArgs(args) || undefined)).id);
}

export const STUDIO_TOOLS: StudioTool[] = [
  studioGetGuidelines,
  studioGetAgentContext,
  studioListRoutines,
  studioListRuns,
  studioGetRun,
  studioListGroupMessages,
  studioListTaskRevisions,
  studioListMemoryRevisions,
  studioGetMemoryVersion,
  studioFindArtifacts,
  studioGetArtifact,
  studioListFileChanges,
  studioGetScript,
  studioGetAgentAccess,
  studioRequestConnectionAccess,
  studioCallConnectionTool,
  studioCreateTaskDraft,
  studioGetGuild,
  studioListGuilds,
  studioListCollections,
  studioGetCollection,
  studioEditMemory,
  studioEditNote,
  studioEditGuild,
  studioEditAccess,
  studioEditCollection,
  studioEditRoutine,
];

export function studioToolSchemas(): Array<Record<string, unknown>> {
  return STUDIO_TOOLS.map((tool) => tool.schema);
}

export function studioToolMap(): Map<string, StudioTool> {
  return new Map(STUDIO_TOOLS.map((tool) => [tool.name, tool]));
}
