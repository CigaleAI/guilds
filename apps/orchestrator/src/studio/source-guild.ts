// The source guild a Studio tool call acts on: its agent a handle names, and the scope its edits take.

import { getAgent, listAgents, type AgentRow } from "../db/agents.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import type { EditScope } from "./edits.js";
import { StudioUnprocessableError } from "./errors.js";
import type { StudioToolCall, StudioToolDeps } from "./tools.js";

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
  const needle = String(handle ?? "").trim();
  if (!needle) {
    return null;
  }
  const byId = await agents.getAgent(needle);
  if (byId && String(byId.guild_id) === String(call.sourceGuildId) && (!call.orgId || String(byId.org_id) === call.orgId)) {
    return byId;
  }
  const members = await agents.listAgents(call.sourceGuildId);
  const lower = needle.toLowerCase();
  const normalized = normalizeAgentHandle(needle);
  const live = members.filter((row) => String(row.guild_id) === String(call.sourceGuildId));
  const match =
    live.find((row) => row.id === needle || String(row.name).toLowerCase() === lower) ??
    live.find((row) => normalizeAgentHandle(String(row.name)) === normalized) ??
    null;
  // The roster query omits org and guild columns; projections need the full row.
  return match ? agents.getAgent(String(match.id)) : null;
}

export function editScope(call: StudioToolCall): EditScope {
  return {
    orgId: call.orgId,
    sourceGuildId: call.sourceGuildId,
    sessionId: String(call.session.id),
    user: call.user,
  };
}
