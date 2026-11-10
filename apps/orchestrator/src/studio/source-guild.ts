// The source guild a Studio session acts on: its agent an id or a handle names, and the scope a
// tool call's edits take.

import { getAgent, listAgents, type AgentRow } from "../db/agents.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import type { EditScope } from "./edits.js";
import { StudioNotFoundError, StudioUnprocessableError } from "./errors.js";
import type { StudioToolCall, StudioToolDeps } from "./tools.js";

/** The agent `agentId` names, when it is an agent of the source guild in the organisation; null otherwise. */
export async function findGuildAgent(
  db: Queryable,
  sourceGuildId: string,
  orgId: string,
  agentId: string,
): Promise<AgentRow | null> {
  const agent = await getAgent(db, agentId);
  return agent && agent.guild_id === sourceGuildId && agent.org_id === orgId ? agent : null;
}

/** The agent `agentId` names in the source guild of the organisation; StudioNotFoundError when it names none there. */
export async function requireGuildAgent(
  db: Queryable,
  sourceGuildId: string,
  orgId: string,
  agentId: string,
): Promise<AgentRow> {
  const agent = await findGuildAgent(db, sourceGuildId, orgId, agentId);
  if (!agent) {
    throw new StudioNotFoundError("agent not found");
  }
  return agent;
}

export async function resolveHandle(
  deps: StudioToolDeps,
  call: StudioToolCall,
  handle: string | undefined,
): Promise<AgentRow> {
  const agent = await resolveSourceGuildAgent(sourceGuildAgents(deps.db), call, handle);
  if (!agent) {
    throw new StudioUnprocessableError(handle ? "agent is not in the source guild" : "agent handle required");
  }
  return agent;
}

function normalizeAgentHandle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** The db/ functions an agent of the source guild is found by handle through, on `db`. */
export function sourceGuildAgents(db: Queryable) {
  return {
    getAgent: bindQuery(db, getAgent),
    listAgents: bindQuery(db, listAgents),
  };
}

export type SourceGuildAgents = ReturnType<typeof sourceGuildAgents>;

export async function resolveSourceGuildAgent(
  agents: SourceGuildAgents,
  call: Pick<StudioToolCall, "sourceGuildId" | "orgId">,
  handle: string | null | undefined,
): Promise<AgentRow | null> {
  const needle = (handle ?? "").trim();
  if (!needle) {
    return null;
  }
  const byId = await agents.getAgent(needle);
  if (byId && byId.guild_id === call.sourceGuildId && (!call.orgId || byId.org_id === call.orgId)) {
    return byId;
  }
  const members = await agents.listAgents(call.sourceGuildId);
  const lower = needle.toLowerCase();
  const normalized = normalizeAgentHandle(needle);
  const live = members.filter((row) => row.guild_id === call.sourceGuildId);
  const match =
    live.find((row) => row.id === needle || row.name.toLowerCase() === lower) ??
    live.find((row) => normalizeAgentHandle(row.name) === normalized) ??
    null;
  // The roster query omits org and guild columns; projections need the full row.
  return match ? agents.getAgent(match.id) : null;
}

export function editScope(call: StudioToolCall): EditScope {
  return {
    orgId: call.orgId,
    sourceGuildId: call.sourceGuildId,
    sessionId: call.session.id,
    user: call.user,
    hidden: call.hidden,
  };
}
