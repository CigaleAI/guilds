import { getAgent } from "../db/agents.js";
import { isPlainRecord, jsonObj } from "../db/json.js";
import type { Queryable } from "../db/pg.js";
import { getRun, listMessages, listRunHeaders, routineRunStats } from "../db/runs.js";
import { listSchedules } from "../db/schedules.js";
import { iso } from "../db/views.js";
import type { GenerationLoop } from "../generation/index.js";
import type { Schedules } from "../schedules/service.js";
import { StudioError } from "./errors.js";

/** What the Studio inspector reads a guild's runs and routines through, built once from the app's services. */
export type InspectorServices = {
  db: Queryable;
  schedules: Schedules;
  /** The generation loop that marks a run while it generates; absent on a box without one. */
  generation: Pick<GenerationLoop, "generating"> | null;
};

/** Which of an agent's runs the inspector lists, as its query asks for them. */
export type RunHeaderQuery = {
  taskPromptHash: string;
  scheduleId: string;
  kind: string;
  limit: unknown;
};

type Item = Record<string, unknown>;

/** The run facts the inspector lists without loading a transcript. */
function runHeader(services: InspectorServices, row: Item): Item {
  const stored = jsonObj(row.metadata);
  const metadata = isPlainRecord(stored) ? stored : {};
  const errors = jsonObj(row.errors);
  const errorList = Array.isArray(errors) ? errors.filter(isPlainRecord) : [];
  const last = errorList[errorList.length - 1];
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    generating: services.generation ? services.generation.generating(String(row.id)) : false,
    task_prompt_hash: row.task_prompt_hash,
    system_prompt_hash: row.system_prompt_hash,
    memory_prompt_hash: row.memory_prompt_hash,
    schedule_id: row.schedule_id ?? null,
    instruction_hash:
      typeof metadata.instruction_hash === "string" ? metadata.instruction_hash : null,
    group_chat_through_seq: row.group_chat_through_seq ?? null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    error_count: errorList.length,
    last_error: last ? { operation: last.operation ?? null, message: last.message ?? null } : null,
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
    taskPromptHash: query.taskPromptHash,
    scheduleId: query.scheduleId,
    kind: query.kind,
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
    throw new StudioError(404, "run not found");
  }
  return {
    run: {
      id: run.id,
      agent_id: run.agent_id,
      kind: run.kind,
      status: run.status,
      task_prompt_hash: run.task_prompt_hash,
      metadata: jsonObj(run.metadata),
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
