import { scriptSourceHash } from "./validation.js";

export type RunScriptSnapshot = {
  id: string;
  name: string;
  description: string;
  parameters: Record<string, unknown> | null;
  source: string;
  source_hash: string;
};

export const RUN_SCRIPT_SNAPSHOT_FIELDS = [
  "id",
  "name",
  "description",
  "parameters",
  "source",
  "source_hash",
] as const;

export function toRunScriptSnapshot(row: Record<string, unknown>): RunScriptSnapshot {
  const source = String(row.source ?? "");
  const hash = typeof row.source_hash === "string" && row.source_hash
    ? row.source_hash
    : scriptSourceHash(source);
  const parameters = row.parameters;
  return {
    id: String(row.id ?? ""),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    parameters:
      parameters && typeof parameters === "object" && !Array.isArray(parameters)
        ? (parameters as Record<string, unknown>)
        : null,
    source,
    source_hash: hash,
  };
}

export function snapshotAgentScripts(rows: Array<Record<string, unknown>>): RunScriptSnapshot[] {
  return rows.map(toRunScriptSnapshot);
}

export function firstClassSnapshots(snapshot: RunScriptSnapshot[]): RunScriptSnapshot[] {
  return snapshot.filter((row) => row.parameters !== null);
}

export function snapshotNameSet(snapshot: RunScriptSnapshot[]): Set<string> {
  return new Set(snapshot.map((row) => row.name));
}

export function liveExtraRows(
  snapshot: RunScriptSnapshot[],
  live: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const pinned = snapshotNameSet(snapshot);
  return live.filter((row) => typeof row.name === "string" && !pinned.has(row.name));
}
