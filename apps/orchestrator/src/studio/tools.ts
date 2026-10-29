import { memoryDiffText, memoryTimeline, type MemoryTimelineEntry } from "../artifacts/memory.js";
import { agentTask } from "../artifacts/task.js";
import { iso } from "../db/views.js";
import { composeAgentSystemPrompt, hydrateStanding, promptHash, schemasOffer } from "../prompts/index.js";
import { Type, type Static } from "@sinclair/typebox";
import { scheduleItem } from "../schedules/item.js";
import { capBytes } from "../lib/bytes.js";
import type { AgentScheduleRow } from "../db/schedules.js";
import type { Schedules } from "../schedules/service.js";
import { previewCurrentState, projectAgentAccess, projectOfferedToolSchemas, type PreviewDeps } from "./preview.js";
import { wrapEvidence } from "./system.js";
import { decodeStudioArguments, studioFunctionSchema } from "./arguments.js";
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
import { getAgent, listAgentTaskRevisions, listAgents, type AgentRow } from "../db/agents.js";
import { listFileChanges } from "../db/file-changes.js";
import { listSchedules, listSchedulesForGuild } from "../db/schedules.js";
import { getRun, listMessages, listRunHeaders, routineRunStats, type MessageRow, type RunHeaderRow } from "../db/runs.js";
import { listGroupMessages } from "../db/group-chat.js";
import { listGuildsForUser } from "../db/guilds.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import { getStudioSession, type StudioSessionRow } from "../db/studio.js";
import type { UserRow } from "../db/users.js";
import { artifactAt, findNotes, parseActorPath } from "../artifacts/notes.js";
import { hashArtifactContent, type ArtifactStore } from "../artifacts/store.js";
import { operatorActor } from "../artifacts/actors.js";

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

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  return Math.min(Math.max(value ?? fallback, 1), max);
}

function cursorOffset(cursor: string | null | undefined): number {
  if (!cursor) {
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
  cursor: string | null | undefined,
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
  schema: studioFunctionSchema("studio_get_guidelines", "Inspect the shared read-only Guidelines source.", Type.Object({})),
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

const GetAgentContextArguments = Type.Object({
  agent_id: Type.String({ description: "Source-guild agent id or name. Required." }),
  sections: Type.Optional(
    Type.Array(Type.String(), {
      description: "Any of task, memory, state, config, effective_prompt, effective_prompt_headers. Defaults to task.",
    }),
  ),
  cursor: Type.Optional(Type.String()),
});
type GetAgentContextArguments = Static<typeof GetAgentContextArguments>;

export const studioGetAgentContext: StudioTool = {
  name: "studio_get_agent_context",
  schema: studioFunctionSchema(
    "studio_get_agent_context",
    "Inspect current prompt sources for one source-guild agent. The first 500 words of each standing task are already in the Studio system prompt. Use this tool for the remainder of a truncated task, the full task, memory, state, config, or effective_prompt (the exact opening system message the next run would receive, with task embeds inlined). Pass agent_id or name.",
    GetAgentContextArguments,
  ),
  async handler(ctx, args) {
    const input: GetAgentContextArguments = decodeStudioArguments(GetAgentContextArguments, args);
    const agent = await resolveHandle(ctx, input.agent_id);
    const want = new Set<string>(input.sections ?? STUDIO_DEFAULT_CONTEXT_SECTIONS);
    const cursor = input.cursor;
    const task = await agentTask(ctx.artifacts, agent);
    const memory = task.memory;
    // state and effective_prompt read the same projection; take it once.
    let statePreview: ReturnType<typeof previewCurrentState> | null = null;
    const currentState = () => (statePreview ??= previewCurrentState(ctx.preview, agent));
    const result: Record<string, unknown> = {
      agent_id: agent.id,
      name: agent.name,
      focus: agent.focus,
    };
    if (want.has("task")) {
      const sliced = sliceStudioBytes(task.text, cursor);
      result.task = {
        display_path: task.displayPath,
        version: task.version,
        content_hash: task.hash,
        has_embeds: task.hasEmbeds,
        ownership: "operator-owned",
        editable: true,
        content: wrapEvidence({ source: "task", coordinates: { version: task.version }, body: sliced.text }),
        ...(sliced.next_cursor ? { next_cursor: sliced.next_cursor } : {}),
        ...(sliced.truncated ? { truncated: true } : {}),
      };
    }
    if (want.has("memory") && memory) {
      const sliced = sliceStudioBytes(memory.content_text ?? "", want.has("task") ? undefined : cursor);
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
      const sliced = sliceStudioBytes(JSON.stringify(preview.state, null, 2), want.has("task") || want.has("memory") ? undefined : cursor);
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
      const effectiveTask = task.expanded.ok ? task.expanded.text : task.text;
      const preview = await currentState();
      const tools = await projectOfferedToolSchemas(ctx.preview, agent);
      const memoryEnabled = agent.config.memory;
      const composed = composeAgentSystemPrompt(
        standing,
        effectiveTask,
        preview.state,
        task.memoryText,
        memoryEnabled,
        memoryEnabled && schemasOffer(tools.schemas, "memory_write"),
      );
      const sliced = sliceStudioBytes(composed, want.size === 1 ? cursor : undefined);
      result.effective_prompt = {
        ownership: "derived",
        editable: false,
        hash: promptHash(composed),
        task_hash: promptHash(effectiveTask),
        memory_hash: promptHash(task.memoryText),
        projected_at: preview.projected_at,
        ...(task.expanded.ok ? {} : { embed_warning: task.expanded.error }),
        content: wrapEvidence({ source: "effective_prompt", coordinates: { agent_id: agent.id }, body: sliced.text }),
        ...(sliced.next_cursor ? { next_cursor: sliced.next_cursor } : {}),
        ...(sliced.truncated ? { truncated: true } : {}),
      };
    }
    if (want.has("effective_prompt_headers")) {
      result.effective_prompt_headers = [
        { section: "guidelines", ownership: "shared", editable: false },
        { section: "task", ownership: "operator-owned", editable: true, version: task.version, content_hash: task.hash },
        { section: "state", ownership: "derived", editable: false },
        { section: "memory", ownership: "agent-owned", editable: true, version: memory?.version },
      ];
    }
    return fitStudioPayload(result);
  },
};

const ListRoutinesArguments = Type.Object({
  agent_id: Type.Optional(Type.String()),
  paused: Type.Optional(Type.Boolean()),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer()),
});
type ListRoutinesArguments = Static<typeof ListRoutinesArguments>;

export const studioListRoutines: StudioTool = {
  name: "studio_list_routines",
  schema: studioFunctionSchema(
    "studio_list_routines",
    "Inspect schedules and instructions for the source guild, or one agent when agent_id is set.",
    ListRoutinesArguments,
  ),
  async handler(ctx, args) {
    const input: ListRoutinesArguments = decodeStudioArguments(ListRoutinesArguments, args);
    const limit = clampLimit(input.limit, STUDIO_DEFAULT_LIMIT, 100);
    const offset = cursorOffset(input.cursor);
    let rows: AgentScheduleRow[];
    if (input.agent_id) {
      const agent = await resolveHandle(ctx, input.agent_id);
      rows = await listSchedules(ctx.db, agent.id);
    } else {
      rows = await listSchedulesForGuild(ctx.db, ctx.sourceGuildId);
    }
    const filtered = rows.filter((row) => input.paused === undefined || row.paused === input.paused);
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

const ListRunsArguments = Type.Object({
  agent_id: Type.Optional(Type.String()),
  kind: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  error_only: Type.Optional(Type.Boolean()),
  task_prompt_hash: Type.Optional(Type.String()),
  schedule_id: Type.Optional(Type.String({ description: "Only runs woken by this routine." })),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer()),
});
type ListRunsArguments = Static<typeof ListRunsArguments>;

export const studioListRuns: StudioTool = {
  name: "studio_list_runs",
  schema: studioFunctionSchema(
    "studio_list_runs",
    "Find behavioral evidence without loading transcripts. kind is direct, group, or schedule; schedule_id lists the runs one routine produced.",
    ListRunsArguments,
  ),
  async handler(ctx, args) {
    const input: ListRunsArguments = decodeStudioArguments(ListRunsArguments, args);
    const agent = await resolveHandle(ctx, input.agent_id);
    const limit = clampLimit(input.limit, STUDIO_DEFAULT_LIMIT, STUDIO_RUN_LIST_MAX);
    const offset = cursorOffset(input.cursor);
    // One row past the page says whether another page follows.
    const rows = await listRunHeaders(ctx.db, agent.id, {
      kind: input.kind,
      status: input.status,
      taskPromptHash: input.task_prompt_hash,
      scheduleId: input.schedule_id,
      errorOnly: input.error_only === true,
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

const GetRunArguments = Type.Object({
  run_id: Type.String(),
  seq_start: Type.Optional(Type.Integer()),
  seq_end: Type.Optional(Type.Integer()),
  tool_name: Type.Optional(Type.String({ description: "Only the turns that called this tool, and their results." })),
});
type GetRunArguments = Static<typeof GetRunArguments>;

export const studioGetRun: StudioTool = {
  name: "studio_get_run",
  schema: studioFunctionSchema(
    "studio_get_run",
    "Read exact historical evidence for a source-guild run. seq_start and seq_end bound the message window. tool_name keeps only the assistant turns that requested that tool and their tool results, for example memory_write or note_write.",
    GetRunArguments,
  ),
  async handler(ctx, args) {
    const input: GetRunArguments = decodeStudioArguments(GetRunArguments, args);
    const runId = input.run_id;
    const run = await getRun(ctx.db, runId);
    if (!run) {
      throw new StudioUnprocessableError("run not found");
    }
    const agent = await getAgent(ctx.db, String(run.agent_id));
    if (!agent || agent.guild_id !== ctx.sourceGuildId) {
      throw new StudioUnprocessableError("run is not in the source guild");
    }
    const seqStart = input.seq_start ?? 0;
    const seqEnd = input.seq_end ?? 10_000;
    const toolName = input.tool_name;
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

const ListGroupMessagesArguments = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer()),
  author_type: Type.Optional(Type.String()),
  author_handle: Type.Optional(Type.String()),
});
type ListGroupMessagesArguments = Static<typeof ListGroupMessagesArguments>;

export const studioListGroupMessages: StudioTool = {
  name: "studio_list_group_messages",
  schema: studioFunctionSchema(
    "studio_list_group_messages",
    "Inspect bounded public guild history.",
    ListGroupMessagesArguments,
  ),
  async handler(ctx, args) {
    const input: ListGroupMessagesArguments = decodeStudioArguments(ListGroupMessagesArguments, args);
    const limit = clampLimit(input.limit, STUDIO_DEFAULT_LIMIT, STUDIO_GROUP_LIST_MAX);
    const offset = cursorOffset(input.cursor);
    const { author_type: authorType, author_handle: authorHandle } = input;
    let rows = await listGroupMessages(ctx.db, ctx.sourceGuildId);
    if (authorType) {
      rows = rows.filter((row) => row.author_type === authorType);
    }
    if (authorHandle) {
      rows = rows.filter((row) => row.author_agent_id === authorHandle || row.author_name === authorHandle);
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

// The arguments of a tool that pages one agent's history.
const AgentHistoryArguments = Type.Object({
  agent_id: Type.Optional(Type.String()),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer()),
});
type AgentHistoryArguments = Static<typeof AgentHistoryArguments>;

export const studioListTaskRevisions: StudioTool = {
  name: "studio_list_task_revisions",
  schema: studioFunctionSchema(
    "studio_list_task_revisions",
    "Inspect prior operator task versions.",
    AgentHistoryArguments,
  ),
  async handler(ctx, args) {
    const input: AgentHistoryArguments = decodeStudioArguments(AgentHistoryArguments, args);
    const agent = await resolveHandle(ctx, input.agent_id);
    const limit = clampLimit(input.limit, STUDIO_DEFAULT_LIMIT, STUDIO_REVISION_LIST_MAX);
    const offset = cursorOffset(input.cursor);
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
  const actor = operatorActor({
    orgId: ctx.orgId,
    actorId: String(ctx.user.id),
    actorName: String(ctx.user.name ?? "operator"),
    guildId: ctx.sourceGuildId,
    agentId: agent.id,
  });
  return (await memoryTimeline(ctx.artifacts, actor, agent.id)).entries;
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
  schema: studioFunctionSchema(
    "studio_list_memory_revisions",
    "List the versions an agent's Memory has held, newest first: who wrote each version (a run id, a user, or the agent), when, and line counts. Content is not included; read one version with studio_get_memory_version.",
    AgentHistoryArguments,
  ),
  async handler(ctx, args) {
    const input: AgentHistoryArguments = decodeStudioArguments(AgentHistoryArguments, args);
    const agent = await resolveHandle(ctx, input.agent_id);
    const limit = clampLimit(input.limit, STUDIO_DEFAULT_LIMIT, STUDIO_REVISION_LIST_MAX);
    const offset = cursorOffset(input.cursor);
    const entries = await memoryTimelineFor(ctx, agent);
    const slice = entries.slice(offset, offset + limit);
    return {
      agent_id: agent.id,
      versions: slice.map(timelineHeader),
      next_cursor: offset + slice.length < entries.length ? String(offset + slice.length) : null,
    };
  },
};

const GetMemoryVersionArguments = Type.Object({
  agent_id: Type.String({ description: "Source-guild agent id or name. Required." }),
  revision_id: Type.Optional(
    Type.String({ description: "Revision id of the version to read. Omit for the live version." }),
  ),
  version_index: Type.Optional(Type.Integer({ description: "Version index from studio_list_memory_revisions." })),
  cursor: Type.Optional(Type.String()),
});
type GetMemoryVersionArguments = Static<typeof GetMemoryVersionArguments>;

export const studioGetMemoryVersion: StudioTool = {
  name: "studio_get_memory_version",
  schema: studioFunctionSchema(
    "studio_get_memory_version",
    "Read one version of an agent's Memory by revision_id or version_index from studio_list_memory_revisions (omit both for the live version), with the line diff against the previous version.",
    GetMemoryVersionArguments,
  ),
  async handler(ctx, args) {
    const input: GetMemoryVersionArguments = decodeStudioArguments(GetMemoryVersionArguments, args);
    const agent = await resolveHandle(ctx, input.agent_id);
    const entries = await memoryTimelineFor(ctx, agent);
    const { revision_id: revisionId, version_index: index } = input;
    const entry = revisionId
      ? entries.find((item) => item.revision_id === revisionId)
      : index !== undefined
        ? entries.find((item) => item.index === index)
        : entries.find((item) => item.revision_id === null);
    if (!entry) {
      throw new StudioUnprocessableError("memory version not found");
    }
    const sliced = sliceStudioBytes(entry.content, input.cursor);
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

const FindArtifactsArguments = Type.Object({
  query: Type.Optional(Type.String({ description: "words to find in note titles and bodies" })),
  level: Type.Optional(Type.String()),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer()),
});
type FindArtifactsArguments = Static<typeof FindArtifactsArguments>;

export const studioFindArtifacts: StudioTool = {
  name: "studio_find_artifacts",
  schema: studioFunctionSchema(
    "studio_find_artifacts",
    "Search notes relevant to the source guild.",
    FindArtifactsArguments,
  ),
  async handler(ctx, args) {
    const input: FindArtifactsArguments = decodeStudioArguments(FindArtifactsArguments, args);
    const limit = clampLimit(input.limit, STUDIO_DEFAULT_LIMIT, STUDIO_ARTIFACT_LIST_MAX);
    const actor = operatorActor({
      orgId: ctx.orgId,
      actorId: String(ctx.user.id),
      actorName: String(ctx.user.name ?? "operator"),
      guildId: ctx.sourceGuildId,
    });
    const findArgs: {
      query: string;
      level?: "agent" | "guild" | "org";
      limit: number;
    } = {
      query: input.query ?? "",
      limit: STUDIO_ARTIFACT_LIST_MAX,
    };
    const level = input.level;
    if (level === "agent" || level === "guild" || level === "org") findArgs.level = level;
    const found = await findNotes(ctx.artifacts, actor, findArgs);
    const allowed = [];
    for (const item of found.notes) {
      if (await studioReachesPath(ctx, String(item.display_path ?? ""))) allowed.push(item);
    }
    const offset = cursorOffset(input.cursor);
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

const GetArtifactArguments = Type.Object({
  display_path: Type.String(),
  cursor: Type.Optional(Type.String()),
});
type GetArtifactArguments = Static<typeof GetArtifactArguments>;

export const studioGetArtifact: StudioTool = {
  name: "studio_get_artifact",
  schema: studioFunctionSchema(
    "studio_get_artifact",
    "Read one artifact by a display path returned from an authorized Studio result.",
    GetArtifactArguments,
  ),
  async handler(ctx, args) {
    const input: GetArtifactArguments = decodeStudioArguments(GetArtifactArguments, args);
    const displayPath = input.display_path;
    const actor = operatorActor({
      orgId: ctx.orgId,
      actorId: String(ctx.user.id),
      actorName: String(ctx.user.name ?? "operator"),
      guildId: ctx.sourceGuildId,
    });
    const parsed = parseActorPath(actor, displayPath);
    if (parsed.kind === "collection") {
      throw new StudioUnprocessableError(`${parsed.collectionName} is a table; read it with studio_get_collection`);
    }
    if (!(await studioReachesParsed(ctx, parsed))) {
      throw new StudioUnprocessableError("artifact is not in the source guild or the organisation's shared files");
    }
    const view = await artifactAt(ctx.artifacts, actor, displayPath);
    if (view.kind !== "row") {
      throw new StudioUnprocessableError("artifact not found");
    }
    const row = view.row;
    const text = row.content_text ?? JSON.stringify(row.content_json ?? {});
    const offset = cursorOffset(input.cursor);
    const encoded = Buffer.from(text, "utf8");
    const slice = encoded.subarray(offset, offset + STUDIO_TOOL_RESULT_MAX_BYTES).toString("utf8");
    return {
      display_path: displayPath,
      kind: row.kind,
      title: row.title,
      version: row.version,
      editable: row.kind === "note",
      content: wrapEvidence({
        source: "artifact",
        coordinates: { display_path: displayPath, version: row.version },
        body: slice,
      }),
      next_cursor: offset + STUDIO_TOOL_RESULT_MAX_BYTES < encoded.length ? String(offset + STUDIO_TOOL_RESULT_MAX_BYTES) : null,
    };
  },
};

const ListFileChangesArguments = Type.Object({
  display_path: Type.String({ description: "Display path from an authorized Studio result. Required." }),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer()),
});
type ListFileChangesArguments = Static<typeof ListFileChangesArguments>;

export const studioListFileChanges: StudioTool = {
  name: "studio_list_file_changes",
  schema: studioFunctionSchema(
    "studio_list_file_changes",
    "List who changed one file and when, newest first: notes, objects, scripts, memory, and standing tasks by display path. A run-written change carries the run id and the tool call that wrote it; read that run with studio_get_run.",
    ListFileChangesArguments,
  ),
  async handler(ctx, args) {
    const input: ListFileChangesArguments = decodeStudioArguments(ListFileChangesArguments, args);
    const displayPath = input.display_path;
    const actor = operatorActor({
      orgId: ctx.orgId,
      actorId: String(ctx.user.id),
      actorName: String(ctx.user.name ?? "operator"),
      guildId: ctx.sourceGuildId,
    });
    if (!(await studioReachesParsed(ctx, parseActorPath(actor, displayPath)))) {
      throw new StudioUnprocessableError("path is not in the source guild or the organisation's shared files");
    }
    const limit = clampLimit(input.limit, STUDIO_DEFAULT_LIMIT, STUDIO_REVISION_LIST_MAX);
    const offset = cursorOffset(input.cursor);
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

const GetScriptArguments = Type.Object({
  agent_id: Type.String({ description: "Source-guild agent id or name. Required." }),
  name: Type.String({ description: "Script name. Required." }),
  cursor: Type.Optional(Type.String()),
});
type GetScriptArguments = Static<typeof GetScriptArguments>;

export const studioGetScript: StudioTool = {
  name: "studio_get_script",
  schema: studioFunctionSchema(
    "studio_get_script",
    "Read the source of one script owned by a source-guild agent. Script names come from the State projection or studio_get_agent_access.",
    GetScriptArguments,
  ),
  async handler(ctx, args) {
    const input: GetScriptArguments = decodeStudioArguments(GetScriptArguments, args);
    const agent = await resolveHandle(ctx, input.agent_id);
    let script: Record<string, unknown>;
    try {
      script = await ctx.preview.scripts.get(agent.id, input.name);
    } catch (error) {
      if (error instanceof ScriptError) {
        throw new StudioUnprocessableError(error.message);
      }
      throw error;
    }
    const sliced = sliceStudioBytes(String(script.source ?? ""), input.cursor);
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

const GetAgentAccessArguments = Type.Object({
  agent_id: Type.String({ description: "Source-guild agent id or name. Required." }),
});
type GetAgentAccessArguments = Static<typeof GetAgentAccessArguments>;

export const studioGetAgentAccess: StudioTool = {
  name: "studio_get_agent_access",
  schema: studioFunctionSchema(
    "studio_get_agent_access",
    "Inspect what one source-guild agent is offered at run start: native tools, scripts, secret names, and MCP connections with their listed tools. Withheld lists name what the agent could be offered but is not. Each connection says whether this Studio session may read through it (studio_granted).",
    GetAgentAccessArguments,
  ),
  async handler(ctx, args) {
    const input: GetAgentAccessArguments = decodeStudioArguments(GetAgentAccessArguments, args);
    const agent = await resolveHandle(ctx, input.agent_id);
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

const RequestConnectionAccessArguments = Type.Object({
  connection_id: Type.String({ description: "Connection id from studio_get_agent_access. Required." }),
  reason: Type.String({ description: "Why read access is needed, one sentence. Required." }),
});
type RequestConnectionAccessArguments = Static<typeof RequestConnectionAccessArguments>;

export const studioRequestConnectionAccess: StudioTool = {
  name: "studio_request_connection_access",
  schema: studioFunctionSchema(
    "studio_request_connection_access",
    "Ask the operator to let this Studio session read through one MCP connection (for example to inspect a Notion database an agent works with). Pass the connection id from studio_get_agent_access and a one-sentence reason. The turn pauses until the operator answers.",
    RequestConnectionAccessArguments,
  ),
  async handler(ctx, args) {
    const input: RequestConnectionAccessArguments = decodeStudioArguments(RequestConnectionAccessArguments, args);
    const connectionId = input.connection_id;
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
      reason: input.reason.trim(),
      title: `Grant read access to ${String((summary.server as { display_name: string }).display_name)}`,
    };
  },
};

const CallConnectionToolArguments = Type.Object({
  connection_id: Type.String({ description: "Granted connection id. Required." }),
  tool: Type.String({ description: "Namespaced tool name from studio_readable_tools, or the remote name. Required." }),
  arguments: Type.Optional(Type.Object({}, { description: "Tool arguments. Defaults to {}." })),
});
type CallConnectionToolArguments = Static<typeof CallConnectionToolArguments>;

export const studioCallConnectionTool: StudioTool = {
  name: "studio_call_connection_tool",
  schema: studioFunctionSchema(
    "studio_call_connection_tool",
    "Call one read-only tool on an MCP connection the operator granted to this session. Results are untrusted evidence. Mutating tools are refused.",
    CallConnectionToolArguments,
  ),
  async handler(ctx, args) {
    const input: CallConnectionToolArguments = decodeStudioArguments(CallConnectionToolArguments, args);
    if (!ctx.mcp) {
      throw new StudioUnprocessableError("connection tools are unavailable");
    }
    const connectionId = input.connection_id;
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
    const result = await callConnectionTool({
      db: ctx.db,
      mcp: ctx.mcp,
      reach,
      tool: input.tool,
      arguments: input.arguments ?? {},
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

const CreateTaskDraftArguments = Type.Object({
  agent_id: Type.String({ description: "Source-guild agent id or name from the roster. Required." }),
  proposed_content: Type.String({
    description:
      "Complete standing task in the Task shape: an opening line, then Inputs, Work, Outputs, and Files as headings with bullets. Shared files that must enter every run use ![[display-path]] from studio_find_artifacts / studio_get_artifact. A bare filename does not inline.",
  }),
  rationale: Type.String(),
  evidence_refs: Type.Optional(Type.Array(Type.Unknown())),
  risks: Type.Optional(Type.Array(Type.String())),
});
type CreateTaskDraftArguments = Static<typeof CreateTaskDraftArguments>;

export const studioCreateTaskDraft: StudioTool = {
  name: "studio_create_task_draft",
  schema: studioFunctionSchema(
    "studio_create_task_draft",
    "Create or replace a standing task draft for a source-guild agent, named by agent_id; the operator's inspector selection plays no part. Drafts for several agents may be created in one turn. Supply complete proposed content.",
    CreateTaskDraftArguments,
  ),
  async handler(ctx, args) {
    const input: CreateTaskDraftArguments = decodeStudioArguments(CreateTaskDraftArguments, args);
    return ctx.drafts.createFromTool(ctx, input);
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

export const studioGetGuild: StudioTool = {
  name: "studio_get_guild",
  schema: studioFunctionSchema(
    "studio_get_guild",
    "Read the source guild's live about (short, one line) and description (long) in full. The system message holds the text from session start, capped; this tool returns the current text.",
    Type.Object({}),
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

const ListGuildsArguments = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer()),
});
type ListGuildsArguments = Static<typeof ListGuildsArguments>;

export const studioListGuilds: StudioTool = {
  name: "studio_list_guilds",
  schema: studioFunctionSchema(
    "studio_list_guilds",
    "Read the organisation's other guilds that the operator can see: each one's name, about (short), and description (long). Their agents, files, and tables stay out of reach; their shared output reaches this guild through organisation tables and notes.",
    ListGuildsArguments,
  ),
  async handler(ctx, args) {
    const input: ListGuildsArguments = decodeStudioArguments(ListGuildsArguments, args);
    const limit = clampLimit(input.limit, STUDIO_DEFAULT_LIMIT, STUDIO_GROUP_LIST_MAX);
    const offset = cursorOffset(input.cursor);
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

const EditMemoryArguments = Type.Object({
  agent_id: Type.String({ description: "Source-guild agent id or name. Required." }),
  content: Type.String({ description: "Complete proposed Memory, not a description of changes. Required." }),
  base_version: Type.Integer({ description: "Memory version the proposal was built from. Required." }),
  reason: Type.String({ description: "Why this edit, one or two sentences, citing evidence. Required." }),
});
type EditMemoryArguments = Static<typeof EditMemoryArguments>;

export const studioEditMemory: StudioTool = {
  name: "studio_edit_memory",
  schema: studioFunctionSchema(
    "studio_edit_memory",
    "Propose a complete replacement of one source-guild agent's Memory. Nothing is written: the turn pauses and the operator applies or declines. Read the live Memory first and pass its version as base_version.",
    EditMemoryArguments,
  ),
  async handler(ctx, args) {
    const input: EditMemoryArguments = decodeStudioArguments(EditMemoryArguments, args);
    const agent = await resolveHandle(ctx, input.agent_id);
    const base = await loadMemoryBase(editScope(ctx), agent);
    return editRequest(base, input, input.base_version);
  },
};

const EditNoteArguments = Type.Object({
  action: Type.String({ enum: ["create", "edit", "delete"], description: "Required." }),
  display_path: Type.Optional(
    Type.String({ description: "edit and delete: display path from studio_find_artifacts or studio_get_artifact." }),
  ),
  base_version: Type.Optional(
    Type.Integer({ description: "edit and delete: the note version the proposal was built from." }),
  ),
  level: Type.Optional(
    Type.String({
      enum: ["agent", "guild", "org"],
      description:
        "create: agent is one agent's own file, guild is read by the source guild's agents, org is read across the organisation.",
    }),
  ),
  agent_id: Type.Optional(Type.String({ description: "create at level agent: source-guild agent id or name." })),
  key: Type.Optional(Type.String({ description: "create: file name ending in .md, no folders, for example playbook.md." })),
  title: Type.Optional(Type.String({ description: "create: short title shown in Files." })),
  content: Type.Optional(
    Type.String({ description: "create and edit: the complete note body, not a description of changes." }),
  ),
  reason: Type.String({ description: "Why this change, one or two sentences, citing evidence. Required." }),
});
type EditNoteArguments = Static<typeof EditNoteArguments>;

/** The agent a note created at level agent belongs to; null at another level or when none is named. */
async function noteAgentId(ctx: StudioToolContext, input: EditNoteArguments): Promise<string | null> {
  if (input.level !== "agent" || !input.agent_id) {
    return null;
  }
  return (await resolveHandle(ctx, input.agent_id)).id;
}

export const studioEditNote: StudioTool = {
  name: "studio_edit_note",
  schema: studioFunctionSchema(
    "studio_edit_note",
    "Propose a change to one note of the source guild, one of its agents, or the organisation. Nothing is written: the turn pauses and the operator applies or declines. create: a new note at the narrowest level that holds every reader; search with studio_find_artifacts first and edit a note that fits instead; the result's target carries the display path to embed or name in a Task draft. edit: a complete replacement of an existing note's body. delete: applying fails while any Task embeds the note, so draft those Tasks first. edit and delete name the note by display_path and pass the version studio_get_artifact returned as base_version. Memory, Tasks, scripts, and records are not changed here.",
    EditNoteArguments,
  ),
  async handler(ctx, args) {
    const input: EditNoteArguments = decodeStudioArguments(EditNoteArguments, args);
    const action = editActionOf(input);
    if (action === "edit") {
      const base = await loadNoteBase(editScope(ctx), input.display_path ?? "");
      return editRequest(base, input, input.base_version ?? null);
    }
    const agentId = action === "create" ? await noteAgentId(ctx, input) : null;
    return noteEditRequest(editScope(ctx), action, input, agentId);
  },
};

const ACCESS_SETTING = Type.String({ enum: ["on", "off", "inherit"] });

const EditAccessArguments = Type.Object({
  agent_id: Type.String({ description: "Source-guild agent id or name. Required." }),
  native_tools: Type.Optional(
    Type.Object(
      {},
      {
        additionalProperties: ACCESS_SETTING,
        description: "Native tool name to setting, from native_tools or withheld_native_tools.",
      },
    ),
  ),
  connections: Type.Optional(
    Type.Object(
      {},
      {
        additionalProperties: ACCESS_SETTING,
        description: "Connection id from studio_get_agent_access to setting: the whole connection for this agent.",
      },
    ),
  ),
  connection_tools: Type.Optional(
    Type.Object(
      {},
      {
        additionalProperties: ACCESS_SETTING,
        description: "Connection tool name from offered_tools or withheld_tools to setting.",
      },
    ),
  ),
  reason: Type.String({ description: "Why this change, one or two sentences, citing evidence. Required." }),
});
type EditAccessArguments = Static<typeof EditAccessArguments>;

export const studioEditAccess: StudioTool = {
  name: "studio_edit_access",
  schema: studioFunctionSchema(
    "studio_edit_access",
    "Propose what one source-guild agent is offered: native tools, whole connections, and single connection tools. Each entry sets the agent's own overlay: on, off, or inherit (drop the overlay and take the guild's setting). Entries left out stay as they are. Nothing is written: the turn pauses and the operator applies or declines. Read the agent with studio_get_agent_access first. The browser, coding, scripting, and memory switches are agent configuration, not access.",
    EditAccessArguments,
  ),
  async handler(ctx, args) {
    const input: EditAccessArguments = decodeStudioArguments(EditAccessArguments, args);
    const agent = await resolveHandle(ctx, input.agent_id);
    return accessEditRequest(editScope(ctx), agent.id, input);
  },
};

const EditGuildArguments = Type.Object({
  about: Type.Optional(Type.String({ description: "Complete proposed about line." })),
  description: Type.Optional(Type.String({ description: "Complete proposed description." })),
  reason: Type.String({ description: "Why this edit, one or two sentences. Required." }),
});
type EditGuildArguments = Static<typeof EditGuildArguments>;

export const studioEditGuild: StudioTool = {
  name: "studio_edit_guild",
  schema: studioFunctionSchema(
    "studio_edit_guild",
    `Propose new text for the source guild's about (short, at most ${ABOUT_MAX} characters), description (long, at most ${DESCRIPTION_MAX} characters), or both. A field left out keeps its live text. Nothing is written: the turn pauses and the operator applies or declines. Read the live text with studio_get_guild first.`,
    EditGuildArguments,
  ),
  async handler(ctx, args) {
    const input: EditGuildArguments = decodeStudioArguments(EditGuildArguments, args);
    const base = await loadGuildBase(editScope(ctx));
    return editRequest(base, input, null);
  },
};

const TABLE_COLUMNS = Type.Array(
  Type.Object(
    {
      name: Type.String({
        description: "^[a-z][a-z0-9_]{0,63}$; id, created_at, updated_at, created_by, and updated_by are reserved.",
      }),
      type: Type.String({ enum: ["text", "number", "boolean", "datetime", "array"] }),
      description: Type.String({ description: "What the value means and how agents should fill it. At most 1000 characters." }),
      required: Type.Optional(Type.Boolean()),
      unique: Type.Optional(
        Type.Boolean({
          description: "Text or number only, at most one per table. A record_add that repeats the value merges into that record.",
        }),
      ),
      values: Type.Optional(
        Type.Array(Type.String(), {
          description: "Text or array only: the closed list of accepted values, such as a queue's state.",
        }),
      ),
      rename_from: Type.Optional(
        Type.String({
          description: "The column's current name when this entry renames it; its values move to the new name.",
        }),
      ),
    },
    { additionalProperties: false },
  ),
  {
    description:
      "create: the typed columns, in display order; every record write is validated against them. edit: the complete column list replacing the current one; keep every column you do not mean to change, since a column left out is dropped from every record.",
  },
);

const TABLE_ACCESS = Type.Object(
  {
    guild: Type.Optional(
      Type.String({
        enum: ["read", "write", "none"],
        description: "The guild's row: the mode of every agent in the guild without a row of its own; none removes the guild's row.",
      }),
    ),
    agents: Type.Optional(
      Type.Array(
        Type.Object(
          {
            agent_id: Type.String({ description: "Source-guild agent id or name." }),
            mode: Type.String({
              enum: ["read", "write", "none", "inherit"],
              description: "The agent's own row over the guild's: none keeps it out; inherit removes its own row.",
            }),
          },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  {
    description: "Who in the source guild reaches the table. Only the entries given change.",
    additionalProperties: false,
  },
);

export const studioListCollections: StudioTool = {
  name: "studio_list_collections",
  schema: studioFunctionSchema(
    "studio_list_collections",
    "List the tables (collections) the source guild's agents can be given: the guild's own, then the organisation's. Each has owner, purpose, record count, column names, the source guild's access, and studio_can: edit_or_delete for the guild's own, add_columns_and_access for the organisation's.",
    Type.Object({}),
  ),
  async handler(ctx) {
    return { collections: await listTables(editScope(ctx)), trust: "untrusted" };
  },
};

const GetCollectionArguments = Type.Object({
  collection: Type.String({ description: "Table name from studio_list_collections. Required." }),
});
type GetCollectionArguments = Static<typeof GetCollectionArguments>;

export const studioGetCollection: StudioTool = {
  name: "studio_get_collection",
  schema: studioFunctionSchema(
    "studio_get_collection",
    "Read one table: purpose, full columns, record count, updated_at (pass it as base_updated_at to studio_edit_collection), the organisation's row, the source guild's row, each source-guild agent's row and resulting access, the rows of other guilds and their agents, and the latest records.",
    GetCollectionArguments,
  ),
  async handler(ctx, args) {
    const input: GetCollectionArguments = decodeStudioArguments(GetCollectionArguments, args);
    return { ...(await readTable(editScope(ctx), input.collection)), trust: "untrusted" };
  },
};

const EditCollectionArguments = Type.Object({
  action: Type.String({ enum: ["create", "edit", "delete"], description: "Required." }),
  collection: Type.Optional(Type.String({ description: "edit and delete: the table's current name." })),
  base_updated_at: Type.Optional(Type.String({ description: "edit: the updated_at studio_get_collection returned." })),
  name: Type.Optional(
    Type.String({
      description:
        "create: ^[a-z][a-z0-9_-]{0,62}$, unique in the organisation. edit: the new name; Tasks, notes, and routines that name the old one must change too.",
    }),
  ),
  purpose: Type.Optional(
    Type.String({ description: "create and edit: one line, at most 400 characters: what one record is and who writes it." }),
  ),
  columns: Type.Optional(TABLE_COLUMNS),
  scope: Type.Optional(
    Type.String({
      enum: ["guild", "org"],
      description: "create: guild (default), the source guild owns the table and starts with the guild at write; org, an organisation table that starts with the organisation at read.",
    }),
  ),
  access: Type.Optional(TABLE_ACCESS),
  reason: Type.String({ description: "Why this change, one or two sentences, citing evidence. Required." }),
});
type EditCollectionArguments = Static<typeof EditCollectionArguments>;

export const studioEditCollection: StudioTool = {
  name: "studio_edit_collection",
  schema: studioFunctionSchema(
    "studio_edit_collection",
    "Propose a change to one table of the source guild or the organisation. Nothing is written: the turn pauses and the operator applies or declines. create: a new table agents read and write with the record tools; check studio_list_collections first and reuse a table that fits. edit: on the source guild's own table, a new name, purpose, column list, or member access; on an organisation table, new columns added to the unchanged current ones, or source-guild access. Fields left out stay as they are. delete: one of the source guild's own tables with every record in it and its access list. edit and delete name the table by collection; read it with studio_get_collection first.",
    EditCollectionArguments,
  ),
  async handler(ctx, args) {
    const input: EditCollectionArguments = decodeStudioArguments(EditCollectionArguments, args);
    return tableEditRequest(editScope(ctx), input);
  },
};

const EditRoutineArguments = Type.Object({
  action: Type.String({ enum: ["create", "edit", "delete"], description: "Required." }),
  agent_id: Type.Optional(Type.String({ description: "create: source-guild agent id or name." })),
  schedule_id: Type.Optional(Type.String({ description: "edit and delete: the routine's id from studio_list_routines." })),
  cron: Type.Optional(
    Type.String({
      description:
        "5-field UTC expression (minute hour day month weekday), for example '0 9 * * 1'; wake-ups at least 5 minutes apart. Pass cron or window, not both.",
    }),
  ),
  window: Type.Optional(
    Type.Object(
      {
        timezone: Type.String({ description: "IANA name, for example Europe/Paris." }),
        start: Type.String({ description: "HH:MM local time." }),
        end: Type.String({ description: "HH:MM local time; earlier than start spans midnight." }),
        max_wakes: Type.Integer({ description: "Most wake-ups per window; gaps are at least 5 minutes." }),
      },
      {
        description: "Random wake-ups inside a daily local-time window. Pass cron or window, not both.",
        additionalProperties: false,
      },
    ),
  ),
  description: Type.Optional(
    Type.String({ description: "One-line label shown in the Routine tab, at most 400 characters." }),
  ),
  instruction: Type.Optional(
    Type.String({
      description: "Short markdown the agent receives on each wake-up, at most 2000 characters: what this wake-up is for, not the agent's whole Task.",
    }),
  ),
  paused: Type.Optional(
    Type.Boolean({ description: "create: true creates it paused. edit: true pauses it; false resumes it." }),
  ),
  reason: Type.String({ description: "Why this change, one or two sentences, citing evidence. Required." }),
});
type EditRoutineArguments = Static<typeof EditRoutineArguments>;

export const studioEditRoutine: StudioTool = {
  name: "studio_edit_routine",
  schema: studioFunctionSchema(
    "studio_edit_routine",
    "Propose a change to one routine of a source-guild agent. Nothing is written: the turn pauses and the operator applies or declines. create: a new routine that wakes one agent on a UTC cron or at random times inside a daily window; check studio_list_routines first and change a routine that fits instead. edit: a new timing, description, instruction, or paused state; fields left out stay as they are. delete: its past runs stay; propose pausing it instead when it may be needed again. edit and delete name the routine by schedule_id from studio_list_routines.",
    EditRoutineArguments,
  ),
  async handler(ctx, args) {
    const input: EditRoutineArguments = decodeStudioArguments(EditRoutineArguments, args);
    const agentId = editActionOf(input) === "create" ? (await resolveHandle(ctx, input.agent_id)).id : null;
    return routineEditRequest(editScope(ctx), { args: input, agentId });
  },
};

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
