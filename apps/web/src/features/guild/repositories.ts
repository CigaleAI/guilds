import type { GithubLogin } from "../../api/types/guilds";

/** Whether a URL names a repository on GitHub, the only host a GitHub login can serve. */
export function isGithubUrl(url: string): boolean {
  return /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+?(\.git)?\/?$/.test(url.trim());
}

/** The login choice that adds a repository without one: it is cloned anonymously. */
export const NO_LOGIN = "none";

/**
 * The GitHub login a repository is added with: the one chosen, or for a GitHub URL the first
 * connected login when none was chosen. Only a GitHub URL can use one.
 */
export function repositoryLogin(
  url: string,
  chosen: string,
  logins: ReadonlyArray<Pick<GithubLogin, "id" | "status">>,
): string | null {
  if (!isGithubUrl(url) || chosen === NO_LOGIN) return null;
  const connected = logins.filter((login) => login.status === "connected");
  return (connected.find((login) => login.id === chosen) ?? connected[0])?.id ?? null;
}
