import type pg from "pg";
import { parseDisplayPath, type ArtifactStore, type ParsedDisplayPath } from "../artifacts/index.js";
import { listAgents } from "../db/agents.js";

// What a Studio session reaches outside its own transcript: the source
// guild, its agents, the organisation's notes, and the tables the source
// guild's agents can be given (its own and the organisation's). Another
// guild's agents, notes, Memory, and tables stay out of reach.

export type StudioReachScope = {
  orgId: string;
  sourceGuildId: string;
  db: pg.Pool;
  artifacts: ArtifactStore;
};

/** A table Studio reads: the source guild's own or the organisation's. */
export function studioReachesTable(sourceGuildId: string, tableGuildId: string | null | undefined): boolean {
  return !tableGuildId || tableGuildId === sourceGuildId;
}

/** Whether a parsed display path lies inside what the session reaches. */
export async function studioReachesParsed(scope: StudioReachScope, parsed: ParsedDisplayPath): Promise<boolean> {
  if (parsed.orgId !== scope.orgId) {
    return false;
  }
  if (parsed.kind === "collection" || parsed.kind === "record") {
    const table = await scope.artifacts.describeCollection(
      scope.artifacts.operatorContext(scope.orgId, "studio", "studio", { guildId: scope.sourceGuildId }),
      parsed.collectionName,
    );
    return Boolean(table) && studioReachesTable(scope.sourceGuildId, table?.guild_id);
  }
  if (parsed.kind === "revision") {
    return (await sourceAgentIds(scope)).has(parsed.agentId);
  }
  if (parsed.level === "agent") {
    return (await sourceAgentIds(scope)).has(parsed.ownerId);
  }
  if (parsed.level === "guild") {
    return parsed.ownerId === scope.sourceGuildId;
  }
  return parsed.level === "org";
}

/** Whether a display path lies inside what the session reaches; a malformed path does not. */
export async function studioReachesPath(scope: StudioReachScope, displayPath: string): Promise<boolean> {
  let parsed: ParsedDisplayPath;
  try {
    parsed = parseDisplayPath(displayPath);
  } catch {
    return false;
  }
  return studioReachesParsed(scope, parsed);
}

async function sourceAgentIds(scope: StudioReachScope): Promise<Set<string>> {
  const agents = await listAgents(scope.db, scope.sourceGuildId);
  return new Set(agents.map((row) => String(row.id)));
}
