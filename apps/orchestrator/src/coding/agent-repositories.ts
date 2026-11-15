import type { AgentPlaceRow } from "../db/agents.js";
import { listGuildRepositories } from "../db/guilds.js";
import { getMcpConnectionForOwner, type McpConnectionRow } from "../db/mcp.js";
import { bindQuery, type BoundQuery, type Queryable } from "../db/pg.js";
import { GITHUB_SERVER_ID } from "../instance/integrations.js";
import { usableRepositories, type CodingRepository } from "./repositories.js";

/** The db/ functions the repositories an agent can use are read through. */
export type CodingRepositoriesDatabase = {
  listGuildRepositories: BoundQuery<typeof listGuildRepositories>;
  getMcpConnectionForOwner: BoundQuery<typeof getMcpConnectionForOwner>;
};

/** The db/ functions the repositories an agent can use are read through, on `db`. */
export function codingRepositoriesDatabase(db: Queryable): CodingRepositoriesDatabase {
  return {
    listGuildRepositories: bindQuery(db, listGuildRepositories),
    getMcpConnectionForOwner: bindQuery(db, getMcpConnectionForOwner),
  };
}

/** The GitHub connection an agent clones with: the agent's, else its guild's, else its organisation's, while connected. */
async function githubConnectionOf(
  db: CodingRepositoriesDatabase,
  agent: AgentPlaceRow,
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

/** The repositories the agent can use: its guild's, with those picked on the GitHub login it clones with. */
export async function loadUsableRepositories(
  db: CodingRepositoriesDatabase,
  agent: AgentPlaceRow,
): Promise<CodingRepository[]> {
  return usableRepositories(await db.listGuildRepositories(agent.guild_id), await githubConnectionOf(db, agent));
}
