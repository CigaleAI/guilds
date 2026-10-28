import type { McpConnectionRow } from "../db/mcp.js";
import type { GithubRepositorySelection } from "../db/schema/index.js";

/** GitHub's id for a repository row or selection entry, or null when none is recorded. */
export function githubIdOf(row: Record<string, unknown>): number | null {
  const id = Number(row.github_id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Repositories pinned on a GitHub connection, or none. */
export function githubRepositoriesOf(
  connection: McpConnectionRow | null | undefined,
): GithubRepositorySelection[] {
  return connection?.settings.repositories ?? [];
}
