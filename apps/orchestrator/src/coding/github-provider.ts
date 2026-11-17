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
import type { GitProvider, TokenEntry } from "./git.js";
import type { PickedRepository } from "./repositories.js";

/** What an installation token may do on repositories the agent pushes to: write their contents, which pushes a branch. */
const PUSH_PERMISSIONS = { contents: "write" } as const satisfies TokenPermissions;

/** What an installation token may do on repositories the agent only reads: read their contents, which clones and fetches. */
const READ_PERMISSIONS = { contents: "read" } as const satisfies TokenPermissions;

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
 * GitHub as a git provider: per GitHub login, one installation token for the repositories that use
 * it and the agent pushes to, limited to them and to pushing branches, and one for those it only
 * reads, limited to them and to reading; answered for github.com.
 */
export class GithubProvider implements GitProvider {
  constructor(
    private db: GithubProviderDb,
    private options: MintOptions = {},
  ) {}

  /**
   * Mints the tokens of every login the repositories use, each scoped to its repositories
   * (`mintRepositoryToken`): one that pushes branches to those the agent pushes to, and one that
   * reads those it only reads. A disconnected login is refused.
   */
  async mint(repositories: PickedRepository[]): Promise<Map<string, TokenEntry>> {
    const entries = new Map<string, TokenEntry>();
    for (const [connectionId, rows] of Map.groupBy(repositories, (row) => row.connection_id)) {
      if (connectionId === null) {
        continue;
      }
      const connection = await this.connectedLogin(connectionId);
      for (const [readOnly, scoped] of Map.groupBy(rows, (row) => row.read_only)) {
        const minted = await this.mintToken(connection, scoped, readOnly ? READ_PERMISSIONS : PUSH_PERMISSIONS);
        for (const row of scoped) {
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

  /** The login's token for `rows`, holding `permissions`. GitHub refusing the installation throws a `RepositoryTokenInstallationGoneError`. */
  private async mintToken(
    connection: McpConnectionRow,
    rows: PickedRepository[],
    permissions: TokenPermissions,
  ): Promise<RepositoryToken> {
    try {
      return await mintRepositoryToken(this.db, { connection, repositories: rows, permissions }, this.options);
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
