import { codingRepositories } from "../coding/repositories.js";
import type { AgentRow } from "../db/agents.js";
import { listGuildRepositories } from "../db/guilds.js";
import { getMcpConnectionForOwner, type McpConnectionRow } from "../db/mcp.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import { GITHUB_SERVER_ID } from "../github/index.js";

/** The db/ functions a coding run's repositories are read through, on `db`. */
export function codingRepositoriesDatabase(db: Queryable) {
  return {
    listGuildRepositories: bindQuery(db, listGuildRepositories),
    getMcpConnectionForOwner: bindQuery(db, getMcpConnectionForOwner),
  };
}

export type CodingRepositoriesDatabase = ReturnType<typeof codingRepositoriesDatabase>;

/** The GitHub connection a coding run of the agent clones with: the agent's, else its guild's, else its organisation's. */
async function githubConnectionOf(
  db: CodingRepositoriesDatabase,
  agent: AgentRow,
): Promise<McpConnectionRow | null> {
  for (const [scope, ownerId] of [
    ["agent", agent.id],
    ["guild", agent.guild_id],
    ["org", agent.org_id],
  ] as const) {
    const row = ownerId ? await db.getMcpConnectionForOwner(GITHUB_SERVER_ID, scope, ownerId) : null;
    if (row !== null && row.status === "connected") {
      return row;
    }
  }
  return null;
}

/** The guild repositories a coding run of the agent clones, with what its GitHub connection reaches. */
export async function guildRepositories(
  db: CodingRepositoriesDatabase,
  agent: AgentRow,
): Promise<Array<Record<string, unknown>>> {
  return codingRepositories(await db.listGuildRepositories(agent.guild_id), await githubConnectionOf(db, agent));
}
