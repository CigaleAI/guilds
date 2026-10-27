import type pg from "pg";
import type { ArtifactStore } from "../artifacts/store.js";
import type { ArtifactActor } from "../artifacts/types.js";
import { listFileChanges } from "../artifacts/file-changes.js";
import { displayPathFor, MEMORY_KEY } from "../artifacts/paths.js";
import { iso } from "../db/views.js";
import { buildMemoryTimeline, type MemoryTimelineEntry } from "./timeline.js";
import { getRun } from "../db/runs.js";

export type MemoryWriteCall = { call_id: string; name: string | null };

export type MemoryHistoryRun = {
  id: string;
  exists: boolean;
  kind: unknown;
  status: unknown;
  schedule_id: unknown;
  created_at: string | null;
  memory_write: MemoryWriteCall | null;
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
  runs: Map<string, Record<string, unknown>>,
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
    created_at: run?.created_at ? iso(run.created_at) : null,
    memory_write: callByRun.get(runId) ?? null,
  };
}

export function attachRunsToMemoryEntries(
  entries: MemoryTimelineEntry[],
  runs: Map<string, Record<string, unknown>>,
  callByRun: Map<string, MemoryWriteCall>,
): Array<MemoryTimelineEntry & { run: MemoryHistoryRun | null }> {
  return entries.map((entry) => ({
    ...entry,
    run: historyRunPayload(entry.run_id, runs, callByRun),
  }));
}

async function runsById(
  db: pg.Pool,
  runIds: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const runs = new Map<string, Record<string, unknown>>();
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
  deps: { artifacts: ArtifactStore; db: pg.Pool },
  actor: ArtifactActor,
  agent: { id: string; name: string },
): Promise<Record<string, unknown>> {
  const live = await deps.artifacts.getMemoryRow(actor, agent.id);
  const revisions = await deps.artifacts.listRevisions(actor, agent.id);
  const entries = buildMemoryTimeline({ live: { content: live?.content_text ?? "" }, revisions });
  const memoryPath = displayPathFor({
    orgId: actor.orgId,
    level: "agent",
    ownerId: agent.id,
    kind: "memory",
    path: "",
    key: MEMORY_KEY,
  });
  const changes = await listFileChanges(deps.db, actor.orgId, memoryPath);
  const callByRun = firstMemoryWriteByRun(changes);
  const runIds = [...new Set(entries.flatMap((entry) => (entry.run_id ? [entry.run_id] : [])))];
  const runs = await runsById(deps.db, runIds);
  return {
    agent: { id: agent.id, name: agent.name },
    display_path: memoryPath,
    live: {
      version: live?.version ?? null,
      content_hash: live?.content_hash ?? null,
    },
    entries: attachRunsToMemoryEntries(entries, runs, callByRun),
  };
}
