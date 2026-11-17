import { Type, type Static } from "typebox";
import { parseGithubUrl } from "../github/index.js";
import { TOKEN_REFRESH_MS } from "../github/tokens.js";
import type { Queryable } from "../db/pg.js";
import type { SandboxFiles } from "../sandbox/sdk.js";
import type { AgentRow } from "../db/agents.js";
import type { RunMcpConnection, RunMcpTool } from "../db/schema/index.js";
import { GITHUB_SERVER_ID } from "../instance/integrations.js";
import { accessTokenProvider } from "./access-token-provider.js";
import { githubProvider } from "./github-provider.js";
import type { CodingRepository, PickedRepository } from "./repositories.js";

/** Where an agent's repository tokens are kept in its machine, outside every home. */
export function gitTokensPath(agentId: string): string {
  return `/run/guilds/${agentId}/git-tokens.json`;
}

/** The author and committer an agent's git commits are made under. */
export type GitIdentity = { name: string; email: string };

/** A repository the helper's `git_setup` could not clone, and git's error for it. */
export const CloneFailure = Type.Object({ name: Type.String(), error: Type.String() });
export type CloneFailure = Static<typeof CloneFailure>;

/** The agent's git identity: its name, and a valid email (guild override or the platform default). */
export function agentGitIdentity(
  agent: Pick<AgentRow, "id" | "name">,
  options: { email?: string | null } = {},
): GitIdentity {
  const email = options.email?.trim() ?? "";
  return { name: agent.name, email: email || `${agent.id}@agents.guilds.run` };
}

/** The git provider a repository's token is minted through, as the repository names it. */
export type GitProviderName = NonNullable<CodingRepository["provider"]>;

/**
 * A repository's entry in the agent's tokens file: the token and the username git's credential
 * helper answers with, only for this host and path, the provider that minted it, and when the
 * token expires (null for one that never does).
 */
export type TokenEntry = {
  token: string;
  expires_at: string | null;
  host: string;
  path: string;
  username: string;
  provider: GitProviderName;
};

/**
 * How a git provider gives its repositories their tokens: the entry of each of `repositories`, all
 * its own, by repository name. Where the provider mints the token, one for a repository the agent
 * only reads is limited to reading it, and any other to pushing branches. A provider whose tokens
 * the box does not mint carries what the host grants, read-only or not.
 */
export type GitProvider = {
  mint(repositories: PickedRepository[]): Promise<Map<string, TokenEntry>>;
};

/** Every git provider, by the name a repository gives it. */
export type GitProviders = Record<GitProviderName, GitProvider>;

/** A connector's tool that opens a pull request: the connector's server, and the tool's own name on it. */
type PullRequestTool = Pick<RunMcpConnection, "server_id"> & Pick<RunMcpTool, "remote_name">;

/**
 * The connector tool that opens a pull request on each provider's repositories, under that
 * connector's login and bindings; none for a provider whose host has no connector.
 */
const PULL_REQUEST_TOOLS: Record<GitProviderName, PullRequestTool | null> = {
  github: { server_id: GITHUB_SERVER_ID, remote_name: "create_pull_request" },
  access_token: null,
};

/**
 * The name the run offers, among its connections `mcp`, the tool that opens a pull request on the
 * provider of one of `repositories`; null when the run is offered none.
 */
export function pullRequestToolOf(
  repositories: CodingRepository[],
  mcp: ReadonlyArray<Pick<RunMcpConnection, "server_id" | "tools">>,
): string | null {
  for (const repository of repositories) {
    const wanted = repository.provider === null ? null : PULL_REQUEST_TOOLS[repository.provider];
    const tool = mcp
      .filter((connection) => connection.server_id === wanted?.server_id)
      .flatMap((connection) => connection.tools)
      .find((item) => item.remote_name === wanted?.remote_name);
    if (tool !== undefined) {
      return tool.name;
    }
  }
  return null;
}

/**
 * The tokens of the repositories a generation's agent picks, each minted through its repository's
 * git provider; a repository without one gets none. Knows when a token needs replacing.
 */
export class RepositoryTokens {
  entries: Record<string, TokenEntry> = {};

  constructor(
    private providers: GitProviders,
    private repositories: PickedRepository[],
  ) {}

  get values(): string[] {
    return Object.values(this.entries).map((entry) => entry.token);
  }

  /** Whether a token expires, so the run replaces it before it does. */
  get hasExpiringTokens(): boolean {
    return Object.values(this.entries).some((entry) => entry.expires_at !== null);
  }

  /** Whether a token expires within `TOKEN_REFRESH_MS` of `now`. */
  needsRefresh(now: Date = new Date()): boolean {
    return Object.values(this.entries).some(
      (entry) => entry.expires_at !== null && Date.parse(entry.expires_at) - now.getTime() <= TOKEN_REFRESH_MS,
    );
  }

  /** Mints the tokens of every repository that names a provider, each provider for its own repositories. */
  async mint(): Promise<void> {
    const entries: Record<string, TokenEntry> = {};
    for (const [provider, rows] of Map.groupBy(this.repositories, (row) => row.provider)) {
      if (provider === null) {
        continue;
      }
      for (const [name, entry] of await this.providers[provider].mint(rows)) {
        entries[name] = entry;
      }
    }
    this.entries = entries;
  }

  /** Writes the agent's tokens under /run/guilds/<agent id> through the sandbox file API, outside every home. */
  async write(files: SandboxFiles, agentId: string): Promise<void> {
    await files.writeFiles([{ path: gitTokensPath(agentId), data: JSON.stringify({ repositories: this.entries }) }]);
  }
}

/** Empties the agent's tokens file, so the credential helper answers for no repository until a run writes it again. */
export async function eraseRepositoryTokens(files: SandboxFiles, agentId: string): Promise<void> {
  await files.writeFiles([{ path: gitTokensPath(agentId), data: JSON.stringify({ repositories: {} }) }]);
}

/** The tokens of a generation's `repositories`, minted and recorded on `db` through each one's git provider. */
export function repositoryTokens(db: Queryable, repositories: PickedRepository[]): RepositoryTokens {
  return new RepositoryTokens({ github: githubProvider(db), access_token: accessTokenProvider(db) }, repositories);
}

const CREDENTIAL_FAILURE = /could not read (username|password)|authentication failed|terminal prompts disabled/i;

/**
 * Why each repository failed to clone. When git wanted credentials, says whether the
 * repository had a token git left unused or had none to give.
 */
export function cloneFailures(
  failed: CloneFailure[],
  repositories: CodingRepository[],
  tokens: Record<string, TokenEntry>,
): string {
  return failed
    .map(({ name, error }) => {
      if (!CREDENTIAL_FAILURE.test(error)) {
        return `${name}: ${error}`;
      }
      if (tokens[name]) {
        return `${name}: git did not use the token issued for it (${error})`;
      }
      const row = repositories.find((item) => item.name === name);
      if (row && parseGithubUrl(row.url) !== null) {
        return `${name}: it has no GitHub login, so it was cloned without credentials: pick a private repository on the GitHub integration instead (${error})`;
      }
      return `${name}: it was cloned without credentials, which only a public repository allows (${error})`;
    })
    .join("; ");
}
