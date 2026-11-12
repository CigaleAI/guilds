import type { InferSelectModel } from "drizzle-orm";
import type { Queryable } from "./pg.js";
import type { guildIssues } from "./schema/index.js";

/** An open blocking issue as the agent it disables is told of it: its id and its summary. */
export type BlockingIssueRow = Pick<InferSelectModel<typeof guildIssues>, "id" | "summary">;

/** A column that holds an agent's id, as the queries that pick the agents to start name it. */
export type AgentIdColumn = "a.id" | "agents.id" | "run_wakes.agent_id";

/**
 * The SQL condition that the agent whose id is `agentIdColumn` has no open blocking issue, for
 * the queries that pick the agents to start.
 */
export function withoutOpenBlockingIssue(agentIdColumn: AgentIdColumn): string {
  return `NOT EXISTS (
    SELECT 1 FROM guild_issues blocking
    WHERE blocking.agent_id = ${agentIdColumn}
      AND blocking.status = 'open'
      AND blocking.severity = 'blocking'
  )`;
}

/** The oldest open blocking issue the agent reported; null when it has none. */
export async function getOpenBlockingIssue(pool: Queryable, agentId: string): Promise<BlockingIssueRow | null> {
  const result = await pool.query<BlockingIssueRow>(
    `SELECT id, summary
     FROM guild_issues
     WHERE agent_id = $1 AND status = 'open' AND severity = 'blocking'
     ORDER BY created_at, id
     LIMIT 1`,
    [agentId],
  );
  return result.rows[0] ?? null;
}
