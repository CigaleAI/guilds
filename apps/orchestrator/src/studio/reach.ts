import { parseDisplayPath, type ParsedDisplayPath } from "../artifacts/paths.js";
import { loadParsed } from "../artifacts/notes.js";
import { listAgents } from "../db/agents.js";
import { hasGuildRow } from "../db/artifact-access.js";
import type { Queryable } from "../db/pg.js";
import { type ArtifactStore } from "../artifacts/store.js";
import { operatorActor } from "../artifacts/actors.js";
import { describeCollection } from "../artifacts/collections.js";

// What a Studio session reaches outside its own transcript: the source
// guild, its agents' Task, Memory, and scripts, the notes and files whose
// access list has a row for the source guild or one of its agents, and the
// tables the source guild's agents can be given (its own and the
// organisation's). Every other note, file, Memory, and table stays out of reach.

/** The stores a reach check reads through. */
export type StudioReachDeps = {
  db: Queryable;
  artifacts: ArtifactStore;
};

/** The organisation and source guild a Studio session reaches from. */
export type StudioReachScope = {
  orgId: string;
  sourceGuildId: string;
};

/** A table Studio reads: the source guild's own or the organisation's. */
export function studioReachesTable(sourceGuildId: string, tableGuildId: string | null | undefined): boolean {
  return !tableGuildId || tableGuildId === sourceGuildId;
}

/** Whether a parsed display path lies inside what the session reaches. */
export async function studioReachesParsed(
  deps: StudioReachDeps,
  scope: StudioReachScope,
  parsed: ParsedDisplayPath,
): Promise<boolean> {
  if (parsed.orgId !== scope.orgId) {
    return false;
  }
  if (parsed.kind === "collection" || parsed.kind === "record") {
    const table = await describeCollection(
      deps.artifacts,
      operatorActor({
        orgId: scope.orgId,
        actorId: "studio",
        actorName: "studio",
        guildId: scope.sourceGuildId,
      }),
      parsed.collectionName,
    );
    return Boolean(table) && studioReachesTable(scope.sourceGuildId, table?.guild_id);
  }
  if (parsed.kind === "revision") {
    return (await sourceAgentIds(deps, scope)).has(parsed.agentId);
  }
  if (parsed.agentId !== null) {
    return (await sourceAgentIds(deps, scope)).has(parsed.agentId);
  }
  const row = await loadParsed(deps.artifacts, parsed);
  if (!row || (row.kind !== "note" && row.kind !== "file")) {
    return false;
  }
  return hasGuildRow(deps.db, { kind: row.kind, id: row.id }, scope.sourceGuildId);
}

/** Whether a display path lies inside what the session reaches; a malformed path does not. */
export async function studioReachesPath(
  deps: StudioReachDeps,
  scope: StudioReachScope,
  displayPath: string,
): Promise<boolean> {
  let parsed: ParsedDisplayPath;
  try {
    parsed = parseDisplayPath(displayPath);
  } catch {
    return false;
  }
  return studioReachesParsed(deps, scope, parsed);
}

async function sourceAgentIds(
  deps: StudioReachDeps,
  scope: StudioReachScope,
): Promise<Set<string>> {
  const agents = await listAgents(deps.db, scope.sourceGuildId);
  return new Set(agents.map((row) => row.id));
}
