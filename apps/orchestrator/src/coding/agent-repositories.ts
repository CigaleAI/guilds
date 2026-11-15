import type { AgentPlaceRow, AgentRow } from "../db/agents.js";
import { listGuildRepositories } from "../db/guilds.js";
import { getMcpConnectionForOwner, type McpConnectionRow } from "../db/mcp.js";
import { bindQuery, type BoundQuery, type Queryable } from "../db/pg.js";
import { GITHUB_SERVER_ID } from "../instance/integrations.js";
import {
  pickedRepositories,
  usableRepositories,
  type CodingRepository,
  type PickedRepositories,
} from "./repositories.js";

/** Why a coding run of an agent cannot start on its repositories: it picks none, or picks one it can no longer use. */
export class AgentRepositoriesError extends Error {
  constructor(
    readonly code: "coding.repositories_missing" | "coding.repositories_gone",
    message: string,
  ) {
    super(message);
    this.name = "AgentRepositoriesError";
  }
}

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

/** The repositories the agent's config picks, in its order: those it can use, and the names of those it can no longer use. */
export async function loadAgentRepositories(
  db: CodingRepositoriesDatabase,
  agent: Pick<AgentRow, "id" | "guild_id" | "org_id" | "config">,
): Promise<PickedRepositories> {
  return pickedRepositories(await loadUsableRepositories(db, agent), agent.config.repositories);
}

/**
 * What stops a coding run from starting on the repositories its agent picks: a name it can no
 * longer use, named, else no repository at all; null when nothing does.
 */
export function agentRepositoriesProblem(picked: PickedRepositories): AgentRepositoriesError | null {
  if (picked.gone.length) {
    return new AgentRepositoriesError(
      "coding.repositories_gone",
      `this agent picks ${picked.gone.join(", ")}, which it can no longer use: add it back in the guild's Repositories, or unpick it in the agent's Settings under Repositories, then send again`,
    );
  }
  if (!picked.repositories.length) {
    return new AgentRepositoriesError(
      "coding.repositories_missing",
      "this agent has no repository: pick one in its Settings under Repositories, then send again",
    );
  }
  return null;
}
