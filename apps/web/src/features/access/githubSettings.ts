import type { GithubSelectedRepository, McpServerAccess } from "../../api/types/access";
import { isRecord } from "../../api/wire";

/** Whether a stored settings value is a repository a GitHub login's coding agents clone. */
export function isGithubSelectedRepository(value: unknown): value is GithubSelectedRepository {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.url === "string" &&
    typeof value.default_branch === "string"
  );
}

/** The repositories a GitHub login's settings hold; none when they hold no list. */
export function selectedRepositories(
  settings: McpServerAccess["settings"],
): GithubSelectedRepository[] {
  const repositories = settings.repositories;
  return Array.isArray(repositories) ? repositories.filter(isGithubSelectedRepository) : [];
}
