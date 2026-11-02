import { iso } from "../db/views.js";
import { parseGithubUrl } from "../github/index.js";
import { githubIdOf, githubRepositoriesOf } from "../github/repositories.js";
import { agentHome } from "../lib/agent-file.js";
import type { GuildRepositoryListItemRow, GuildRepositoryRow } from "../db/guilds.js";
import type { McpConnectionRow } from "../db/mcp.js";
import type { GithubRepositorySelection } from "../db/schema/index.js";
import type { GithubSelection, RepositoryDraft } from "./guild-repositories.js";

export const REPOSITORY_NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/;
/** The branch a repository without a GitHub connection is recorded with when none is given. */
export const DEFAULT_BRANCH = "main";
const BRANCH_RE = /^(?!\/|.*\/\/|.*\.\.|.*@\{|.*\/$|.*\.lock$)[A-Za-z0-9._/-]{1,200}$/;

export class RepositoryValidationError extends Error {
  status: number;

  constructor(message: string, status = 422) {
    super(message);
    this.name = "RepositoryValidationError";
    this.status = status;
  }
}

export type RepositoryInput = {
  name: string;
  url: string;
  defaultBranch: string | null;
  connectionId: string | null;
};

/** A git repository of a guild as the operator app reads it, with the GitHub login it is cloned with when it has one. */
export type GuildRepository = Pick<GuildRepositoryRow, "id" | "guild_id" | "name" | "url" | "default_branch" | "connection_id"> & {
  connection: {
    id: string;
    status: GuildRepositoryListItemRow["connection_status"];
    account_hint: McpConnectionRow["account_hint"];
  } | null;
  created_at: string;
  updated_at: string;
};

/** A GitHub login a guild may use when adding repositories. */
export type GithubLogin = Pick<McpConnectionRow, "id" | "owner_scope" | "owner_id" | "account_hint" | "status">;

/**
 * A repository a coding agent clones: its name, URL and branch, GitHub's id for it when known, and
 * the GitHub login it is cloned with, with that login's status and account, when it has one.
 */
export type CodingRepository = Pick<
  GuildRepositoryListItemRow,
  "name" | "url" | "default_branch" | "github_id" | "connection_id" | "connection_status" | "connection_account"
>;

/** A guild repository as a run's state lists it: where it sits in the agent's home. */
export type StateRepository = { name: string; path: string; default_branch: string };

export function validateRepositoryInput(body: RepositoryDraft): RepositoryInput {
  const name = body.name.trim();
  if (!REPOSITORY_NAME_RE.test(name)) {
    throw new RepositoryValidationError("name must match ^[a-z][a-z0-9_-]{0,62}$");
  }
  const url = body.url.trim();
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
  const defaultBranch = body.default_branch?.trim() || null;
  if (defaultBranch !== null && !BRANCH_RE.test(defaultBranch)) {
    throw new RepositoryValidationError("default_branch is not a valid branch name");
  }
  const connectionId = body.connection_id || null;
  if (connectionId !== null && parseGithubUrl(url) === null) {
    throw new RepositoryValidationError(
      "with a GitHub connection, url must be https://github.com/<owner>/<repository>",
    );
  }
  return { name, url, defaultBranch, connectionId };
}

export function repositoryItem(row: GuildRepositoryListItemRow): GuildRepository {
  const connectionId = row.connection_id;
  return {
    id: row.id,
    guild_id: row.guild_id,
    name: row.name,
    url: row.url,
    default_branch: row.default_branch,
    connection_id: connectionId,
    connection:
      connectionId === null
        ? null
        : {
            id: connectionId,
            status: row.connection_status,
            account_hint: row.connection_account ?? "",
          },
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

/** The repositories stored on a GitHub login. */
export function validateGithubRepositories(repositories: GithubSelection): GithubRepositorySelection[] {
  const seen = new Set<string>();
  const selected: GithubRepositorySelection[] = [];
  for (const item of repositories) {
    const input = validateRepositoryInput({ ...item, connection_id: "github" });
    if (seen.has(input.name)) {
      throw new RepositoryValidationError(`the login already has a repository named ${input.name}`);
    }
    seen.add(input.name);
    const githubId = githubIdOf(item);
    if (item.github_id !== undefined && item.github_id !== null && githubId === null) {
      throw new RepositoryValidationError("github_id must be a positive integer");
    }
    selected.push({
      name: input.name,
      url: input.url,
      default_branch: input.defaultBranch ?? DEFAULT_BRANCH,
      ...(githubId === null ? {} : { github_id: githubId }),
    });
  }
  return selected;
}

/**
 * What a coding agent clones: the effective GitHub login's selected repositories, plus this
 * guild's other git URLs (anonymous, or a login that is not that effective one).
 */
export function codingRepositories(
  guildRepos: CodingRepository[],
  github: McpConnectionRow | null | undefined,
): CodingRepository[] {
  const selected = githubRepositoriesOf(github).map((item): CodingRepository => ({
    name: item.name,
    url: item.url,
    default_branch: item.default_branch,
    github_id: item.github_id ?? null,
    connection_id: github?.id ?? null,
    connection_status: github?.status ?? null,
    connection_account: github?.account_hint ?? "",
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
