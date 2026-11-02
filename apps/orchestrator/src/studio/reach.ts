import { parseDisplayPath, TASK_KEY, type ParsedDisplayPath } from "../artifacts/paths.js";
import { loadParsed } from "../artifacts/notes.js";
import { parseRecordId } from "../artifacts/search.js";
import { listAgents } from "../db/agents.js";
import { isInGuildScope } from "../db/artifact-access.js";
import { listArtifactsEverAt } from "../db/artifacts.js";
import { getRecordOrTombstone } from "../db/collections.js";
import type { ChangeTarget } from "../db/file-changes.js";
import type { Queryable } from "../db/pg.js";
import { type ArtifactStore } from "../artifacts/store.js";
import { operatorActor } from "../artifacts/actors.js";
import { describeCollection } from "../artifacts/collections.js";

// What a Studio session reaches outside its own transcript: the source
// guild, its agents' Task, Memory, and scripts, the notes and files whose
// access list has a row for the source guild, one of its agents, or the organisation, and the
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
    const table = await describeCollection(deps.artifacts, studioTableActor(scope), parsed.collectionName);
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
  return isInGuildScope(deps.db, { kind: row.kind, id: row.id }, scope.sourceGuildId);
}

/** The studio actor a table's reach is read as: an operator of the source guild. */
function studioTableActor(scope: StudioReachScope) {
  return operatorActor({ orgId: scope.orgId, actorId: "studio", actorName: "studio", guildId: scope.sourceGuildId });
}

/**
 * Whose changes a display path's history shows the session: every note or file that sat at the
 * path, live or deleted, in the source guild's scope; a source agent's Task, Memory, or script; a
 * record of a table the session reaches. Nothing for any other path.
 */
export async function studioChangeTarget(
  deps: StudioReachDeps,
  scope: StudioReachScope,
  parsed: ParsedDisplayPath,
): Promise<ChangeTarget> {
  const none: ChangeTarget = { artifactIds: [], taskAgentId: null };
  if (parsed.orgId !== scope.orgId || parsed.kind === "revision" || parsed.kind === "collection") {
    return none;
  }
  if (parsed.kind === "record") {
    const table = await describeCollection(deps.artifacts, studioTableActor(scope), parsed.collectionName);
    if (!table || !studioReachesTable(scope.sourceGuildId, table.guild_id)) {
      return none;
    }
    const record = await getRecordOrTombstone(deps.db, table.id, parseRecordId(parsed.recordId));
    return record ? { artifactIds: [record.id], taskAgentId: null } : none;
  }
  const address = { org_id: parsed.orgId, agent_id: parsed.agentId, path: parsed.path, key: parsed.key };
  if (parsed.agentId !== null) {
    if (!(await sourceAgentIds(deps, scope)).has(parsed.agentId)) {
      return none;
    }
    if (parsed.path === "" && parsed.key === TASK_KEY) {
      return { artifactIds: [], taskAgentId: parsed.agentId };
    }
    return { artifactIds: (await listArtifactsEverAt(deps.db, address)).map((row) => row.id), taskAgentId: null };
  }
  const rows = await listArtifactsEverAt(deps.db, address);
  const reached = await Promise.all(
    rows.map(async (row) =>
      (row.kind === "note" || row.kind === "file") &&
      (await isInGuildScope(deps.db, { kind: row.kind, id: row.id }, scope.sourceGuildId))
        ? [row.id]
        : [],
    ),
  );
  return { artifactIds: reached.flat(), taskAgentId: null };
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
