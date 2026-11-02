import type { GithubSelection } from "../coding/guild-repositories.js";
import type { CodingRepository } from "../coding/repositories.js";
import type { McpConnectionRow } from "../db/mcp.js";
import type { GithubRepositorySelection } from "../db/schema/index.js";

/** A repository a GitHub token is minted for: one a coding agent clones, or one a GitHub login picked. */
export type TokenScopedRepository = CodingRepository | GithubRepositorySelection;

/** GitHub's id for a repository, or for a pick as an operator sends it, or null when none is recorded. */
export function githubIdOf(repository: TokenScopedRepository | GithubSelection[number]): number | null {
  const id = Number(repository.github_id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Repositories pinned on a GitHub connection, or none. */
export function githubRepositoriesOf(
  connection: McpConnectionRow | null | undefined,
): GithubRepositorySelection[] {
  return connection?.settings.repositories ?? [];
}
