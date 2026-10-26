import { jsonObj } from "../db/json.js";
import { iso } from "../db/views.js";
import { parseGithubUrl } from "../github/index.js";
import { agentHome } from "../lib/agent-file.js";

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

export function validateRepositoryInput(body: Record<string, unknown>): RepositoryInput {
  const name = String(body.name ?? "").trim();
  if (!REPOSITORY_NAME_RE.test(name)) {
    throw new RepositoryValidationError("name must match ^[a-z][a-z0-9_-]{0,62}$");
  }
  const url = String(body.url ?? "").trim();
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
  const rawBranch = body.default_branch;
  let defaultBranch: string | null = null;
  if (rawBranch !== undefined && rawBranch !== null && String(rawBranch).trim() !== "") {
    defaultBranch = String(rawBranch).trim();
    if (!BRANCH_RE.test(defaultBranch)) {
      throw new RepositoryValidationError("default_branch is not a valid branch name");
    }
  }
  const rawConnection = body.connection_id;
  const connectionId =
    rawConnection === undefined || rawConnection === null || rawConnection === "" ? null : String(rawConnection);
  if (connectionId !== null && parseGithubUrl(url) === null) {
    throw new RepositoryValidationError(
      "with a GitHub connection, url must be https://github.com/<owner>/<repository>",
    );
  }
  return { name, url, defaultBranch, connectionId };
}

export function repositoryItem(row: Record<string, unknown>): Record<string, unknown> {
  const connectionId = row.connection_id === null || row.connection_id === undefined ? null : String(row.connection_id);
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
            status: row.connection_status ?? null,
            account_hint: row.connection_account ?? "",
          },
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export type GithubRepositorySelection = {
  name: string;
  url: string;
  default_branch: string;
  /** GitHub's id for the repository, which a rename of it or its owner keeps. */
  github_id?: number;
};

/** GitHub's id for a repository row or selection entry, or null when none is recorded. */
export function githubIdOf(row: Record<string, unknown>): number | null {
  const id = Number(row.github_id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** The repositories stored on a GitHub login. */
export function validateGithubRepositories(value: unknown): GithubRepositorySelection[] {
  if (!Array.isArray(value)) {
    throw new RepositoryValidationError("repositories must be an array");
  }
  const seen = new Set<string>();
  const selected: GithubRepositorySelection[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new RepositoryValidationError("repositories entries must be objects");
    }
    const input = validateRepositoryInput({
      ...(item as Record<string, unknown>),
      connection_id: "github",
    });
    if (seen.has(input.name)) {
      throw new RepositoryValidationError(`the login already has a repository named ${input.name}`);
    }
    seen.add(input.name);
    const raw = (item as Record<string, unknown>).github_id;
    const githubId = githubIdOf(item as Record<string, unknown>);
    if (raw !== undefined && raw !== null && githubId === null) {
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

/** Repositories pinned on a GitHub connection, or none. */
export function githubRepositoriesOf(
  connection: Record<string, unknown> | null | undefined,
): GithubRepositorySelection[] {
  if (!connection) {
    return [];
  }
  try {
    const settings = jsonObj(connection.settings) as { repositories?: unknown } | null;
    return validateGithubRepositories(settings?.repositories ?? []);
  } catch {
    return [];
  }
}

/**
 * What a coding agent clones: the effective GitHub login's selected repositories, plus this
 * guild's other git URLs (anonymous, or a login that is not that effective one).
 */
export function codingRepositories(
  guildRepos: Array<Record<string, unknown>>,
  github: Record<string, unknown> | null | undefined,
): Array<Record<string, unknown>> {
  const selected = githubRepositoriesOf(github).map((item) => ({
    name: item.name,
    url: item.url,
    default_branch: item.default_branch,
    github_id: item.github_id ?? null,
    connection_id: github ? String(github.id) : null,
    connection_status: github?.status ?? null,
    connection_account: github?.account_hint ?? "",
  }));
  const selectedNames = new Set(selected.map((item) => item.name));
  const extras = guildRepos.filter((row) => !selectedNames.has(String(row.name)));
  return [...selected, ...extras];
}

/** A GitHub login a guild may use when adding repositories. */
export function githubLoginItem(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    owner_scope: row.owner_scope,
    owner_id: row.owner_id === null || row.owner_id === undefined ? null : String(row.owner_id),
    account_hint: row.account_hint ?? "",
    status: row.status,
  };
}

/** State's `repositories`: where each guild repository sits in the agent's home. */
export function stateRepositories(
  rows: Array<Record<string, unknown>>,
  agentId: string,
): Array<Record<string, string>> {
  return rows.map((row) => ({
    name: String(row.name),
    path: `${agentHome(agentId)}/repos/${String(row.name)}`,
    default_branch: String(row.default_branch),
  }));
}
