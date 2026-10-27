import { isPlainRecord } from "../db/json.js";
import type { AgentScript } from "./catalog.js";

export type RunScriptSnapshot = Omit<AgentScript, "agent_id">;

export const RUN_SCRIPT_SNAPSHOT_FIELDS = [
  "id",
  "name",
  "description",
  "parameters",
  "source",
  "source_hash",
] as const;

export function toRunScriptSnapshot(script: AgentScript): RunScriptSnapshot {
  return {
    id: script.id,
    name: script.name,
    description: script.description,
    parameters: script.parameters,
    source: script.source,
    source_hash: script.source_hash,
  };
}

export function snapshotAgentScripts(scripts: AgentScript[]): RunScriptSnapshot[] {
  return scripts.map(toRunScriptSnapshot);
}

export function firstClassSnapshots(snapshot: RunScriptSnapshot[]): RunScriptSnapshot[] {
  return snapshot.filter((row) => row.parameters !== null);
}

export function snapshotNameSet(snapshot: RunScriptSnapshot[]): Set<string> {
  return new Set(snapshot.map((row) => row.name));
}

export function liveExtraRows(snapshot: RunScriptSnapshot[], live: AgentScript[]): AgentScript[] {
  const pinned = snapshotNameSet(snapshot);
  return live.filter((script) => !pinned.has(script.name));
}

function isRunScriptSnapshot(value: unknown): value is RunScriptSnapshot {
  return (
    isPlainRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    typeof value.source === "string" &&
    typeof value.source_hash === "string" &&
    (value.parameters === null || isPlainRecord(value.parameters))
  );
}

/** The scripts a run's snapshot pins, or null when it pins none; an entry that is not a script is left out. */
export function pinnedScripts(value: unknown): RunScriptSnapshot[] | null {
  return Array.isArray(value) ? value.filter(isRunScriptSnapshot) : null;
}
