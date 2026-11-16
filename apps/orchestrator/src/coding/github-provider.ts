import { GithubInstallationGoneError, type TokenPermissions } from "../github/index.js";
import {
  loginAccount,
  mintRepositoryToken,
  RepositoryAccessError,
  githubRepositoryRecorder,
  type MintOptions,
  type RepositoryToken,
} from "../github/tokens.js";
import { getMcpConnection, type McpConnectionRow } from "../db/mcp.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import type { GitProvider, GitTokenScope, TokenEntry } from "./git.js";
import type { CodingRepository } from "./repositories.js";

/**
 * What an installation token may do on its repositories, by scope: write their contents, which
 * pushes a branch, and with pull requests also open them, as a coding agent's `gh` does.
 */
const SCOPE_PERMISSIONS = {
  push: { contents: "write" },
  push_and_pull_requests: { contents: "write", pull_requests: "write" },
} as const satisfies Record<GitTokenScope, TokenPermissions>;

/** The username git sends with a GitHub installation token. */
const INSTALLATION_TOKEN_USERNAME = "x-access-token";

/** The db/ functions GitHub mints and records a run's repository tokens through, on `db`. */
function githubProviderDatabase(db: Queryable) {
  return {
    ...githubRepositoryRecorder(db),
    getMcpConnection: bindQuery(db, getMcpConnection),
  };
}

export type GithubProviderDb = ReturnType<typeof githubProviderDatabase>;

/**
 * GitHub refused the installation behind `connection` while a run's repository token was minted.
 * Its caller retires the login with `retireInstallationGone`, as the message tells the run. The error keeps the name
 * `RepositoryAccessError`, the type a run's error record shows for every token failure.
 */
export class RepositoryTokenInstallationGoneError extends RepositoryAccessError {
  readonly connection: McpConnectionRow;

  constructor(connection: McpConnectionRow) {
    super(`GitHub refused the installation for ${loginAccount(connection)}; the connection is now disconnected`);
    this.connection = connection;
  }
}

/**
 * GitHub as a git provider: one installation token per GitHub login, limited to the repositories
 * that use it and to the permissions of the run's scope, answered for github.com.
 */
export class GithubProvider implements GitProvider {
  constructor(
    private db: GithubProviderDb,
    private options: MintOptions = {},
  ) {}

  /**
   * Mints a token for every login the repositories use, scoped to those repositories
   * (`mintRepositoryToken`) and to the permissions of `scope`. A disconnected login is refused.
   */
  async mint(repositories: CodingRepository[], scope: GitTokenScope): Promise<Map<string, TokenEntry>> {
    const entries = new Map<string, TokenEntry>();
    for (const [connectionId, rows] of Map.groupBy(repositories, (row) => row.connection_id)) {
      if (connectionId === null) {
        continue;
      }
      const minted = await this.mintCodingToken(await this.connectedLogin(connectionId), rows, scope);
      for (const row of rows) {
        entries.set(row.name, {
          token: minted.token,
          expires_at: minted.expiresAt,
          host: "github.com",
          path: minted.paths.get(row.name)!,
          username: INSTALLATION_TOKEN_USERNAME,
          provider: "github",
        });
      }
    }
    return entries;
  }

  /** The connection a repository uses, refused unless it is connected. */
  private async connectedLogin(connectionId: string): Promise<McpConnectionRow> {
    const connection = await this.db.getMcpConnection(connectionId);
    if (connection === null || connection.status !== "connected") {
      const account = connection?.account_hint ?? "";
      throw new RepositoryAccessError(`the GitHub connection${account ? ` for ${account}` : ""} is disconnected`);
    }
    return connection;
  }

  /** The login's token for its repositories here, within `scope`. GitHub refusing the installation throws a `RepositoryTokenInstallationGoneError`. */
  private async mintCodingToken(
    connection: McpConnectionRow,
    rows: CodingRepository[],
    scope: GitTokenScope,
  ): Promise<RepositoryToken> {
    try {
      return await mintRepositoryToken(
        this.db,
        { connection, repositories: rows, permissions: SCOPE_PERMISSIONS[scope] },
        this.options,
      );
    } catch (error) {
      if (!(error instanceof GithubInstallationGoneError)) {
        throw error;
      }
      throw new RepositoryTokenInstallationGoneError(connection);
    }
  }
}

/** GitHub as the git provider of a run's repositories, minting and recording on `db`. */
export function githubProvider(db: Queryable): GithubProvider {
  return new GithubProvider(githubProviderDatabase(db));
}
