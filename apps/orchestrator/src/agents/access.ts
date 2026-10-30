import { getAgent, type AgentRow } from "../db/agents.js";
import { getGuild } from "../db/guilds.js";
import { getMembership } from "../db/orgs.js";
import type { Queryable } from "../db/pg.js";
import { getRun, type RunRow } from "../db/runs.js";
import { canSeeGuild } from "../guilds/operators.js";
import { AgentError } from "./errors.js";

/** Whether the user is in the organisation and sees the guild. */
async function seesGuildOf(
  db: Queryable,
  agent: Pick<AgentRow, "org_id" | "guild_id">,
  userId: string,
): Promise<boolean> {
  if ((await getMembership(db, agent.org_id, userId)) === null) {
    return false;
  }
  const guild = await getGuild(db, agent.guild_id);
  return guild !== null && canSeeGuild(guild, userId);
}

/** An agent the user sees: one in a guild they see. Any other is a 404. */
export async function requireVisibleAgent(
  db: Queryable,
  agentId: string,
  userId: string,
): Promise<AgentRow> {
  const row = await getAgent(db, agentId);
  if (row === null || !(await seesGuildOf(db, row, userId))) {
    throw new AgentError(404, "agent not found");
  }
  return row;
}

/** A run the user sees: one of an agent they see. Any other is a 404. */
export async function requireVisibleRun(
  db: Queryable,
  runId: string,
  userId: string,
): Promise<RunRow> {
  const row = await getRun(db, runId);
  const agent = row === null ? null : await getAgent(db, row.agent_id);
  if (row === null || agent === null || !(await seesGuildOf(db, agent, userId))) {
    throw new AgentError(404, "run not found");
  }
  return row;
}
