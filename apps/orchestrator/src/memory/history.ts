import type { ArtifactStore } from "../artifacts/store.js";
import type { ArtifactActor } from "../artifacts/types.js";
import { readableChangeTarget } from "../artifacts/notes.js";
import { listFileChanges } from "../db/file-changes.js";
import { iso } from "../db/views.js";
import { memoryTimeline, type MemoryTimelineEntry } from "../artifacts/memory.js";
import type { AgentRow } from "../db/agents.js";
import { getRun, type RunRow } from "../db/runs.js";
import type { Queryable } from "../db/pg.js";

export type MemoryWriteCall = { call_id: string; name: string | null };

/** A run as the memory history reads it: what kind it was, its status, its schedule and when it started. */
export type MemoryRun = Pick<RunRow, "kind" | "status" | "schedule_id" | "created_at">;

/** The run that wrote a memory version; `exists` is false, and its fields null, once the run is gone. */
export type MemoryHistoryRun = {
  id: string;
  exists: boolean;
  kind: MemoryRun["kind"] | null;
  status: MemoryRun["status"] | null;
  schedule_id: MemoryRun["schedule_id"];
  created_at: string | null;
  memory_write: MemoryWriteCall | null;
};

/** A memory version with the run that wrote it; null for a version an operator wrote. */
export type MemoryHistoryEntry = MemoryTimelineEntry & { run: MemoryHistoryRun | null };

/** Every version an agent's memory has held, newest first, as the operator reads it. */
export type MemoryHistory = {
  agent: Pick<AgentRow, "id" | "name">;
  display_path: string;
  /** The live memory's version and content hash; both null when the agent has no memory yet. */
  live: { version: number | null; content_hash: string | null };
  entries: MemoryHistoryEntry[];
};

export function firstMemoryWriteByRun(
  changes: Array<{ run?: { id: string } | null; tool?: MemoryWriteCall | null }>,
): Map<string, MemoryWriteCall> {
  const callByRun = new Map<string, MemoryWriteCall>();
  for (const change of changes) {
    if (!change.run?.id || !change.tool || callByRun.has(change.run.id)) {
      continue;
    }
    callByRun.set(change.run.id, { call_id: change.tool.call_id, name: change.tool.name });
  }
  return callByRun;
}

export function historyRunPayload(
  runId: string | null,
  runs: Map<string, MemoryRun>,
  callByRun: Map<string, MemoryWriteCall>,
): MemoryHistoryRun | null {
  if (!runId) {
    return null;
  }
  const run = runs.get(runId);
  return {
    id: runId,
    exists: Boolean(run),
    kind: run?.kind ?? null,
    status: run?.status ?? null,
    schedule_id: run?.schedule_id ?? null,
    created_at: run ? iso(run.created_at) : null,
    memory_write: callByRun.get(runId) ?? null,
  };
}

export function attachRunsToMemoryEntries(
  entries: MemoryTimelineEntry[],
  runs: Map<string, MemoryRun>,
  callByRun: Map<string, MemoryWriteCall>,
): MemoryHistoryEntry[] {
  return entries.map((entry) => ({
    ...entry,
    run: historyRunPayload(entry.run_id, runs, callByRun),
  }));
}

async function runsById(
  db: Queryable,
  runIds: string[],
): Promise<Map<string, MemoryRun>> {
  const runs = new Map<string, MemoryRun>();
  for (const runId of runIds) {
    const run = await getRun(db, runId);
    if (run) {
      runs.set(runId, run);
    }
  }
  return runs;
}

// Every version an agent's memory has held, newest first, as the operator
// reads it: the actor that wrote each one and, for run-written versions, the
// run and the memory_write call that did it. The archive is operator-only,
// so `actor` is an operator.
export async function memoryHistory(
  deps: { artifacts: ArtifactStore; db: Queryable },
  actor: ArtifactActor,
  agent: Pick<AgentRow, "id" | "name">,
): Promise<MemoryHistory> {
  const timeline = await memoryTimeline(deps.artifacts, actor, agent.id);
  const changes = await listFileChanges(deps.db, actor.orgId, await readableChangeTarget(deps.artifacts, actor, timeline.displayPath));
  const callByRun = firstMemoryWriteByRun(changes);
  const runIds = [...new Set(timeline.entries.flatMap((entry) => (entry.run_id ? [entry.run_id] : [])))];
  const runs = await runsById(deps.db, runIds);
  return {
    agent: { id: agent.id, name: agent.name },
    display_path: timeline.displayPath,
    live: {
      version: timeline.live?.version ?? null,
      content_hash: timeline.live?.contentHash ?? null,
    },
    entries: attachRunsToMemoryEntries(timeline.entries, runs, callByRun),
  };
}
