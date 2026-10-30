import { Type, type Static } from "@sinclair/typebox";
import type { ArtifactStore } from "../artifacts/store.js";
import { agentTask } from "../artifacts/task.js";
import { getAgent, type AgentRow } from "../db/agents.js";
import type { Queryable } from "../db/pg.js";
import { getRun, listMessages, listRunHeaders, routineRunStats, type RunHeaderRow } from "../db/runs.js";
import { listSchedules } from "../db/schedules.js";
import { iso } from "../db/views.js";
import type { GenerationLoop } from "../generation/index.js";
import { composeAgentSystemPrompt, hydrateStanding, promptHash, schemasOffer } from "../prompts/index.js";
import type { Schedules } from "../schedules/service.js";
import { StudioNotFoundError } from "./errors.js";
import { previewCurrentState, projectOfferedToolSchemas, type PreviewDeps } from "./preview.js";

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

type Item = Record<string, unknown>;

/** The run facts the inspector lists without loading a transcript. */
function runHeader(services: InspectorServices, row: RunHeaderRow): Item {
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
): Promise<Item[]> {
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
): Promise<Item> {
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
): Promise<Item[]> {
  const rows = await listSchedules(services.db, agentId);
  const byRoutine = await routineRunStats(
    services.db,
    rows.map((row) => row.id),
  );
  const items = [];
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

/** One agent as the inspector shows it: its Guidelines, task, state, Memory, and effective prompt beside its latest run. */
export async function inspectAgent(deps: AgentInspectorDeps, agent: AgentRow): Promise<Record<string, unknown>> {
  const task = await agentTask(deps.artifacts, agent);
  const standing = hydrateStanding({
    systemPath: deps.notesSystemPath,
    agentName: agent.name,
    agentId: agent.id,
  });
  const preview = await previewCurrentState(deps.preview, agent);
  const effectiveTask = task.expanded.ok ? task.expanded.text : task.text;
  const effectiveHash = promptHash(effectiveTask);
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
