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
