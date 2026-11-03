import { Type, type Static } from "typebox";
import type { ArtifactStore } from "../artifacts/store.js";
import { agentTaskShownTo } from "../artifacts/task.js";
import type { ArtifactActor } from "../artifacts/types.js";
import { getAgent, type AgentRow } from "../db/agents.js";
import type { Queryable } from "../db/pg.js";
import { getRun, listMessages, listRunHeaders, routineRunStats, type MessageRow, type RunHeaderRow, type RunRow } from "../db/runs.js";
import type { RunError } from "../db/schema/index.js";
import type { ScheduleItem } from "../schedules/item.js";
import { listSchedules } from "../db/schedules.js";
import { iso } from "../db/views.js";
import type { GenerationLoop } from "../generation/index.js";
import { composeAgentSystemPrompt, hydrateStanding, promptHash, schemasOffer } from "../prompts/index.js";
import type { Schedules } from "../schedules/service.js";
import { StudioNotFoundError } from "./errors.js";
import { nextRunTaskHash, previewStateShownTo, projectOfferedToolSchemas, type PreviewDeps, type StatePreview } from "./preview.js";

/** What the Studio inspector reads a guild's runs and routines through, built once from the app's services. */
export type InspectorServices = {
  db: Queryable;
  schedules: Schedules;
  /** The generation loop that marks a run while it generates; absent on a box without one. */
  generation: Pick<GenerationLoop, "isGenerating"> | null;
};

/** Which of an agent's runs the inspector lists: by prompt, routine, or kind, and how many. */
export const RunHeaderQuerySchema = Type.Object({
  task_prompt_hash: Type.Optional(Type.String()),
  schedule_id: Type.Optional(Type.String()),
  kind: Type.Optional(Type.String()),
  limit: Type.Optional(Type.String()),
});

export type RunHeaderQuery = Static<typeof RunHeaderQuerySchema>;

/** A run as the inspector lists it, without its transcript: its prompts' hashes, its routine, and its errors. */
export type StudioRun = Pick<
  RunHeaderRow,
  | "id"
  | "kind"
  | "status"
  | "task_prompt_hash"
  | "system_prompt_hash"
  | "memory_prompt_hash"
  | "schedule_id"
  | "group_chat_through_seq"
> & {
  generating: boolean;
  instruction_hash: string | null;
  created_at: string;
  updated_at: string;
  error_count: number;
  last_error: Pick<RunError, "operation" | "message"> | null;
};

/** A routine as the inspector lists it: the routine, how many runs it woke, and the latest of them. */
export type StudioRoutine = ScheduleItem & { run_count: number; latest_run: StudioRun | null };

/** A run of the session's guild with its transcript. */
export type GuildRunView = {
  run: Pick<RunRow, "id" | "agent_id" | "kind" | "status" | "task_prompt_hash" | "metadata">;
  messages: MessageRow[];
};

/** The run facts the inspector lists without loading a transcript. */
function runHeader(services: InspectorServices, row: RunHeaderRow): StudioRun {
  const last = row.errors.at(-1);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    generating: services.generation ? services.generation.isGenerating(row.id) : false,
    task_prompt_hash: row.task_prompt_hash,
    system_prompt_hash: row.system_prompt_hash,
    memory_prompt_hash: row.memory_prompt_hash,
    schedule_id: row.schedule_id,
    instruction_hash: row.metadata.instruction_hash ?? null,
    group_chat_through_seq: row.group_chat_through_seq,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    error_count: row.errors.length,
    last_error: last ? { operation: last.operation, message: last.message } : null,
  };
}

/** An agent's runs, newest first, filtered by prompt, routine, or kind; 100 by default and 500 at most. */
export async function listAgentRunHeaders(
  services: InspectorServices,
  agentId: string,
  query: RunHeaderQuery,
): Promise<StudioRun[]> {
  const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
  const filter = {
    taskPromptHash: query.task_prompt_hash ?? "",
    scheduleId: query.schedule_id ?? "",
    kind: query.kind ?? "",
    limit,
  };
  return (await listRunHeaders(services.db, agentId, filter)).map((row) =>
    runHeader(services, row),
  );
}

/** A run of the session's guild with its transcript; a run of another guild is a 404. */
export async function readGuildRun(
  services: InspectorServices,
  guildId: string,
  runId: string,
): Promise<GuildRunView> {
  const run = await getRun(services.db, runId);
  const agent = run === null ? null : await getAgent(services.db, run.agent_id);
  if (run === null || agent === null || agent.guild_id !== guildId) {
    throw new StudioNotFoundError("run not found");
  }
  return {
    run: {
      id: run.id,
      agent_id: run.agent_id,
      kind: run.kind,
      status: run.status,
      task_prompt_hash: run.task_prompt_hash,
      metadata: run.metadata,
    },
    messages: await listMessages(services.db, run.id),
  };
}

/** An agent's routines, each with how many runs it woke and the latest of them. */
export async function listAgentRoutines(
  services: InspectorServices,
  agentId: string,
): Promise<StudioRoutine[]> {
  const rows = await listSchedules(services.db, agentId);
  const byRoutine = await routineRunStats(
    services.db,
    rows.map((row) => row.id),
  );
  const items: StudioRoutine[] = [];
  for (const row of rows) {
    const stats = byRoutine.get(row.id);
    items.push({
      ...(await services.schedules.view(row)),
      run_count: stats?.count ?? 0,
      latest_run: stats?.latest ? runHeader(services, stats.latest) : null,
    });
  }
  return items;
}

/** What the agent inspector reads an agent's prompt sources through. */
export type AgentInspectorDeps = {
  db: Queryable;
  artifacts: ArtifactStore;
  preview: PreviewDeps;
  notesSystemPath: string;
  isAgentBusy?: ((agentId: string) => boolean) | undefined;
};

/** A prompt source as the inspector shows it: whose it is, and whether Studio may propose an edit to it. */
type InspectedSource = { ownership: "shared" | "operator-owned" | "agent-owned" | "derived"; editable: boolean };

/**
 * One agent's prompt as the inspector shows it: its Guidelines, Task, State, and Memory, the
 * effective prompt they compose beside the latest run's, and the tools it is offered.
 */
export type StudioInspector = {
  agent: Pick<AgentRow, "id" | "name" | "focus" | "config">;
  guidelines: InspectedSource & { content: string; content_hash: string };
  task: InspectedSource & {
    display_path: string;
    version: number;
    content: string;
    content_hash: string;
    effective_hash: string;
    effective_matches_source: boolean;
    has_embeds: boolean;
    embed_warning: string | null;
  };
  state: InspectedSource & { projected_at: string; content: StatePreview["state"] };
  memory: InspectedSource & { content: string; content_hash: string | null; prompt_hash: string };
  effective_prompt: {
    content: string;
    hash: string;
    task_content: string;
    sections: { guidelines_hash: string; task_hash: string; memory_hash: string };
    latest_run: {
      id: string;
      kind: RunHeaderRow["kind"];
      created_at: string;
      guidelines_match: boolean;
      task_match: boolean;
      memory_match: boolean;
    } | null;
  };
  offered_tools: { catalog_revision: string | null; count: number };
  generating: boolean;
};

/**
 * One agent as the inspector shows it to the operator `viewer`: its Guidelines, task, state, Memory,
 * and effective prompt beside its latest run, the Task's embeds inlined as `agentTaskShownTo` does
 * and its State's tables as `previewStateShownTo` lists them. The Task's effective hash is the one
 * its next run records (`nextRunTaskHash`), so it compares with the latest run's whatever is hidden
 * from the viewer.
 */
export async function inspectAgent(deps: AgentInspectorDeps, viewer: ArtifactActor, agent: AgentRow): Promise<StudioInspector> {
  const task = await agentTaskShownTo(deps.artifacts, viewer, agent);
  const standing = hydrateStanding({
    systemPath: deps.notesSystemPath,
    agentName: agent.name,
    agentId: agent.id,
  });
  const preview = await previewStateShownTo(deps.preview, viewer, agent);
  const effectiveTask = task.expanded.ok ? task.expanded.text : task.text;
  const effectiveHash = await nextRunTaskHash(deps.artifacts, agent);
  const tools = await projectOfferedToolSchemas(deps.preview, agent);
  const memoryEnabled = agent.config.memory;
  const composed = composeAgentSystemPrompt(
    standing,
    effectiveTask,
    preview.state,
    task.memoryText,
    memoryEnabled,
    memoryEnabled && schemasOffer(tools.schemas, "memory_write"),
  );
  const latestRun = (await listRunHeaders(deps.db, agent.id, { limit: 1 }))[0] ?? null;
  const guidelinesHash = promptHash(standing);
  const memoryPromptHash = promptHash(task.memoryText);
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
      display_path: task.displayPath,
      version: task.version,
      content: task.text,
      content_hash: task.hash,
      effective_hash: effectiveHash,
      effective_matches_source: task.hash === effectiveHash,
      has_embeds: task.hasEmbeds,
      embed_warning: task.expanded.ok ? null : task.expanded.error,
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
      content: task.memory?.content_text ?? "",
      content_hash: task.memory?.content_hash ?? null,
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
    generating: deps.isAgentBusy?.(agent.id) ?? false,
  };
}
