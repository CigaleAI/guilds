import { iso } from "../db/views.js";
import { parseGithubUrl } from "../github/index.js";
import { remoteIdOf, githubRepositoriesOf } from "../github/repositories.js";
import { agentHome } from "../lib/agent-file.js";
import type { GuildRepositoryListItemRow, GuildRepositoryRow } from "../db/guilds.js";
import type { McpConnectionRow } from "../db/mcp.js";
import type { RepositorySelection } from "../db/schema/index.js";
import type { RepositorySelectionDraft, RepositoryDraft } from "./guild-repositories.js";

export const REPOSITORY_NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/;
/** The branch a repository without a GitHub login is recorded with when none is given. */
export const DEFAULT_BRANCH = "main";
const BRANCH_RE = /^(?!\/|.*\/\/|.*\.\.|.*@\{|.*\/$|.*\.lock$)[A-Za-z0-9._/-]{1,200}$/;
/** A username git can send with an access token: one line without spaces or control characters. */
const USERNAME_RE = /^[^\s\p{Cc}]{1,256}$/u;

export class RepositoryValidationError extends Error {
  status: number;

  constructor(message: string, status = 422) {
    super(message);
    this.name = "RepositoryValidationError";
    this.status = status;
  }
}

/**
 * The credential a repository is cloned with, by its provider: a GitHub login, the secret that
 * holds an access token and the username sent with it, or none.
 */
export type RepositoryCredential = {
  provider: GuildRepositoryRow["provider"];
  connectionId: string | null;
  secretId: string | null;
  username: string | null;
};

export type RepositoryInput = RepositoryCredential & {
  name: string;
  url: string;
  defaultBranch: string | null;
};

/**
 * A git repository of a guild as the operator app reads it, with its provider: the GitHub login
 * it is cloned with, or the secret holding its access token and its username, when it has one.
 */
export type GuildRepository = Pick<
  GuildRepositoryRow,
  "id" | "guild_id" | "name" | "url" | "default_branch" | "provider" | "connection_id" | "secret_id" | "username"
> & {
  connection: {
    id: string;
    status: GuildRepositoryListItemRow["connection_status"];
    account_hint: McpConnectionRow["account_hint"];
  } | null;
  secret: { id: string; name: string } | null;
  created_at: string;
  updated_at: string;
};

/** A GitHub login a guild may use when adding repositories. */
export type GithubLogin = Pick<McpConnectionRow, "id" | "owner_scope" | "owner_id" | "account_hint" | "status">;

/**
 * A repository a coding agent clones: its name, URL and branch, its host's id for it when known,
 * and the provider its token is minted through: its GitHub login, with that login's status and
 * account, or the secret holding its access token and the username git sends with it.
 */
export type CodingRepository = Pick<
  GuildRepositoryListItemRow,
  | "name"
  | "url"
  | "default_branch"
  | "remote_id"
  | "provider"
  | "connection_id"
  | "connection_status"
  | "connection_account"
  | "secret_id"
  | "username"
>;

/** A guild repository as a run's state lists it: where it sits in the agent's home. */
export type StateRepository = { name: string; path: string; default_branch: string };

/** The GitHub login `connectionId` as a repository's credential, for `url`; only a `https://github.com/<owner>/<repository>` URL takes one. */
function validateGithubCredential(connectionId: string, url: string): RepositoryCredential {
  if (parseGithubUrl(url) === null) {
    throw new RepositoryValidationError(
      "with a GitHub connection, url must be https://github.com/<owner>/<repository>",
    );
  }
  return { provider: "github", connectionId, secretId: null, username: null };
}

/**
 * An access token's secret and username as a repository's credential, on any host, or none when
 * neither is given. Half of one, or a username git cannot send, is refused.
 */
function validateAccessTokenCredential(secretId: string | null, username: string | null): RepositoryCredential {
  if (secretId === null && username === null) {
    return { provider: null, connectionId: null, secretId: null, username: null };
  }
  if (secretId === null || username === null || !USERNAME_RE.test(username)) {
    throw new RepositoryValidationError(
      "an access token takes secret_id and a username of one line without spaces, of at most 256 characters",
    );
  }
  return { provider: "access_token", connectionId: null, secretId, username };
}

/**
 * The credential a repository's draft names, for its `url`: a GitHub login, an access token's
 * secret and username, or none. A draft naming both is refused.
 */
function validateRepositoryCredential(body: RepositoryDraft, url: string): RepositoryCredential {
  const connectionId = body.connection_id || null;
  const secretId = body.secret_id || null;
  const username = body.username?.trim() || null;
  if (connectionId !== null && (secretId !== null || username !== null)) {
    throw new RepositoryValidationError("a repository takes one credential: a GitHub login or an access token");
  }
  if (connectionId !== null) {
    return validateGithubCredential(connectionId, url);
  }
  return validateAccessTokenCredential(secretId, username);
}

/** A repository's URL, trimmed: an https git URL on any host, without credentials, query, or fragment. */
function validateRepositoryUrl(raw: string): string {
  const url = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RepositoryValidationError("url must be an https git URL");
  }
  if (parsed.protocol !== "https:" || !parsed.host || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new RepositoryValidationError(
      "url must be an https git URL without credentials, query, or fragment",
    );
  }
  return url;
}

export function validateRepositoryInput(body: RepositoryDraft): RepositoryInput {
  const name = body.name.trim();
  if (!REPOSITORY_NAME_RE.test(name)) {
    throw new RepositoryValidationError("name must match ^[a-z][a-z0-9_-]{0,62}$");
  }
  const url = validateRepositoryUrl(body.url);
  const defaultBranch = body.default_branch?.trim() || null;
  if (defaultBranch !== null && !BRANCH_RE.test(defaultBranch)) {
    throw new RepositoryValidationError("default_branch is not a valid branch name");
  }
  return { name, url, defaultBranch, ...validateRepositoryCredential(body, url) };
}

export function repositoryItem(row: GuildRepositoryListItemRow): GuildRepository {
  const connectionId = row.connection_id;
  return {
    id: row.id,
    guild_id: row.guild_id,
    name: row.name,
    url: row.url,
    default_branch: row.default_branch,
    provider: row.provider,
    connection_id: connectionId,
    connection:
      connectionId === null
        ? null
        : {
            id: connectionId,
            status: row.connection_status,
            account_hint: row.connection_account ?? "",
          },
    secret_id: row.secret_id,
    username: row.username,
    secret: row.secret_id === null ? null : { id: row.secret_id, name: row.secret_name ?? "" },
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

/** The repositories stored on a GitHub login. */
export function validateGithubRepositories(repositories: RepositorySelectionDraft): RepositorySelection[] {
  const seen = new Set<string>();
  const selected: RepositorySelection[] = [];
  for (const item of repositories) {
    const input = validateRepositoryInput({ ...item, connection_id: "github" });
    if (seen.has(input.name)) {
      throw new RepositoryValidationError(`the login already has a repository named ${input.name}`);
    }
    seen.add(input.name);
    const remoteId = remoteIdOf(item);
    if (item.remote_id !== undefined && item.remote_id !== null && remoteId === null) {
      throw new RepositoryValidationError("remote_id must be a positive integer");
    }
    selected.push({
      name: input.name,
      url: input.url,
      default_branch: input.defaultBranch ?? DEFAULT_BRANCH,
      ...(remoteId === null ? {} : { remote_id: remoteId }),
    });
  }
  return selected;
}

/**
 * The repositories an agent can use: the selected repositories of the GitHub login it clones
 * with, plus its guild's other git URLs (anonymous, or a login that is not that one).
 */
export function usableRepositories(
  guildRepos: CodingRepository[],
  github: McpConnectionRow | null | undefined,
): CodingRepository[] {
  const selected = githubRepositoriesOf(github).map((item): CodingRepository => ({
    name: item.name,
    url: item.url,
    default_branch: item.default_branch,
    remote_id: item.remote_id ?? null,
    provider: "github",
    connection_id: github?.id ?? null,
    connection_status: github?.status ?? null,
    connection_account: github?.account_hint ?? "",
    secret_id: null,
    username: null,
  }));
  const selectedNames = new Set(selected.map((item) => item.name));
  const extras = guildRepos.filter((row) => !selectedNames.has(row.name));
  return [...selected, ...extras];
}

/** A GitHub login a guild may use when adding repositories. */
export function githubLoginItem(row: McpConnectionRow): GithubLogin {
  return {
    id: row.id,
    owner_scope: row.owner_scope,
    owner_id: row.owner_id,
    account_hint: row.account_hint,
    status: row.status,
  };
}

/** State's `repositories`: where each guild repository sits in the agent's home. */
export function stateRepositories(rows: CodingRepository[], agentId: string): StateRepository[] {
  return rows.map((row) => ({
    name: row.name,
    path: `${agentHome(agentId)}/repos/${row.name}`,
    default_branch: row.default_branch,
  }));
}
