import type { AgentConfig } from "../../api/types/agents";
import type { GithubLogin, RepositoryInput } from "../../api/types/guilds";
import type { Secret } from "../../api/types/secrets";

/** Whether a URL names a repository on GitHub, the only host a GitHub login can serve. */
export function isGithubUrl(url: string): boolean {
  return /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+?(\.git)?\/?$/.test(url.trim());
}

/** The credential choice that adds a repository without one: it is cloned anonymously. */
export const NO_CREDENTIAL = "none";

/** The credential choice that adds a repository with an access token kept as a secret. */
export const ACCESS_TOKEN = "access_token";

/** The credential a repository is added with: a GitHub login, an access token, or none. */
export type RepositoryCredential =
  { kind: "github"; connectionId: string } | { kind: "access_token" } | { kind: "none" };

/**
 * The credential a repository is added with, from the one chosen: an access token on any host; a
 * GitHub login only for a GitHub URL, the first connected one when none was chosen; else none.
 */
export function repositoryCredential(
  url: string,
  chosen: string,
  logins: ReadonlyArray<Pick<GithubLogin, "id" | "status">>,
): RepositoryCredential {
  if (chosen === ACCESS_TOKEN) return { kind: "access_token" };
  if (!isGithubUrl(url) || chosen === NO_CREDENTIAL) return { kind: "none" };
  const connected = logins.filter((login) => login.status === "connected");
  const login = connected.find((item) => item.id === chosen) ?? connected[0];
  return login ? { kind: "github", connectionId: login.id } : { kind: "none" };
}

/** The choice a credential shows as in the credential select: its login's id, `ACCESS_TOKEN`, or `NO_CREDENTIAL`. */
export function credentialChoice(credential: RepositoryCredential): string {
  if (credential.kind === "github") return credential.connectionId;
  if (credential.kind === "access_token") return ACCESS_TOKEN;
  return NO_CREDENTIAL;
}

/** Whether a credential has what it needs: a secret and a username for an access token. */
export function isCredentialComplete(
  credential: RepositoryCredential,
  secretId: string,
  username: string,
): boolean {
  return credential.kind !== "access_token" || (secretId !== "" && username.trim() !== "");
}

/** What a credential adds to a repository's request: a GitHub login, or an access token's secret and username. */
export function credentialRequest(
  credential: RepositoryCredential,
  secretId: string,
  username: string,
): Pick<RepositoryInput, "connection_id" | "secret_id" | "username"> {
  if (credential.kind === "github") return { connection_id: credential.connectionId };
  if (credential.kind === "access_token") return { secret_id: secretId, username: username.trim() };
  return {};
}

/** The secrets an operator may give a repository as its access token: the ones they manage. */
export function accessTokenSecrets(secrets: readonly Secret[]): Secret[] {
  return secrets.filter((secret) => secret.can_manage);
}

/** The repositories an agent picks, in its order, and those of them it only reads. */
export type RepositoryPicks = Pick<AgentConfig, "repositories" | "read_only_repositories">;

/**
 * A repository an agent's checklist offers: one it can use, or one it picks and can no longer
 * use, and whether it picks it read-only.
 */
export type RepositoryChoice = { name: string; picked: boolean; usable: boolean; readOnly: boolean };

/** The checklist of an agent's repositories: each one it can use, then each it picks and can no longer use. */
export function repositoryChoices(usable: readonly string[], picks: RepositoryPicks): RepositoryChoice[] {
  const { repositories: picked, read_only_repositories: readOnly } = picks;
  return [
    ...usable.map((name) => ({ name, picked: picked.includes(name), usable: true, readOnly: readOnly.includes(name) })),
    ...picked
      .filter((name) => !usable.includes(name))
      .map((name) => ({ name, picked: true, usable: false, readOnly: readOnly.includes(name) })),
  ];
}

/**
 * The picks with `name` taken out when they hold it, out of the read-only ones too, else added
 * after the others, writable.
 */
export function togglePickedRepository(picks: RepositoryPicks, name: string): RepositoryPicks {
  if (!picks.repositories.includes(name)) {
    return { ...picks, repositories: [...picks.repositories, name] };
  }
  return {
    repositories: picks.repositories.filter((item) => item !== name),
    read_only_repositories: picks.read_only_repositories.filter((item) => item !== name),
  };
}

/** The picks with the picked repository `name` read-only when it was writable, else writable. */
export function toggleReadOnlyRepository(picks: RepositoryPicks, name: string): RepositoryPicks {
  const readOnly = picks.read_only_repositories;
  return {
    ...picks,
    read_only_repositories: readOnly.includes(name) ? readOnly.filter((item) => item !== name) : [...readOnly, name],
  };
}

/** Whether the agent picks a repository it can use, which a turn in repositories needs to start. */
export function picksUsableRepository(usable: readonly string[], picked: readonly string[]): boolean {
  return picked.some((name) => usable.includes(name));
}
