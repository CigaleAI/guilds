import type pg from "pg";
import { GithubInstallationGoneError, parseGithubUrl, type GithubAppConfig, type TokenPermissions } from "../github/index.js";
import {
  loginAccount,
  mintRepositoryToken,
  RepositoryAccessError,
  TOKEN_REFRESH_MS,
  githubRepositoryRecorder,
  type RepositoryToken,
} from "../github/tokens.js";
import { getMcpConnection, saveMcpConnection } from "../db/mcp.js";
import { bindQuery } from "../db/pg.js";
import { markDisconnected } from "../mcp/index.js";
import type { FetchFn } from "../net/http.js";
import type { SandboxFiles } from "../toolbox/types.js";

/** Where an agent's repository tokens are kept in its machine, outside every home. */
export function gitTokensPath(agentId: string): string {
  return `/run/guilds/${agentId}/git-tokens.json`;
}

/** What a coding agent's git and `gh` may do on its repositories. */
const CODING_PERMISSIONS: TokenPermissions = { contents: "write", pull_requests: "write" };

/** The agent's git identity: its name, and a valid email (guild override or the platform default). */
export function agentGitIdentity(
  agent: Record<string, unknown>,
  options: { email?: string | null } = {},
): { name: string; email: string } {
  const email = typeof options.email === "string" ? options.email.trim() : "";
  return { name: String(agent.name), email: email || `${String(agent.id)}@agents.guilds.run` };
}

export type TokenEntry = { token: string; expires_at: string; host: string; path: string };

/** The db/ functions a run's repository tokens are minted and stored through, on `db`. */
export function repositoryTokenDatabase(db: pg.Pool) {
  return {
    ...githubRepositoryRecorder(db),
    getMcpConnection: bindQuery(db, getMcpConnection),
    saveMcpConnection: bindQuery(db, saveMcpConnection),
  };
}

export type RepositoryTokenDb = ReturnType<typeof repositoryTokenDatabase>;

/**
 * The installation tokens of a run's guild repositories, one per GitHub connection, each
 * limited to the repositories that use it. Knows when a token needs replacing.
 */
export class RepositoryTokens {
  entries: Record<string, TokenEntry> = {};
  private expiries: number[] = [];

  constructor(
    private db: RepositoryTokenDb,
    private repositories: Array<Record<string, unknown>>,
    private options: { app?: GithubAppConfig; fetch?: FetchFn; masterKey?: Buffer; now?: () => Date } = {},
  ) {}

  /** The repositories that use a GitHub connection. */
  get connected(): Array<Record<string, unknown>> {
    return this.repositories.filter((row) => row.connection_id !== null && row.connection_id !== undefined);
  }

  get values(): string[] {
    return Object.values(this.entries).map((entry) => entry.token);
  }

  needsRefresh(now = this.now()): boolean {
    return this.expiries.some((expiry) => expiry - now.getTime() <= TOKEN_REFRESH_MS);
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  /**
   * Mints a token for every connection the repositories use, with what a coding agent's git
   * and `gh` need, scoped to those repositories (`mintRepositoryToken`). A disconnected
   * connection is refused.
   */
  async mint(): Promise<void> {
    const byConnection = new Map<string, Array<Record<string, unknown>>>();
    for (const row of this.connected) {
      const id = String(row.connection_id);
      byConnection.set(id, [...(byConnection.get(id) ?? []), row]);
    }
    const entries: Record<string, TokenEntry> = {};
    const expiries: number[] = [];
    for (const [connectionId, rows] of byConnection) {
      const minted = await this.mintCodingToken(await this.connectedLogin(connectionId), rows);
      expiries.push(Date.parse(minted.expiresAt));
      for (const row of rows) {
        entries[String(row.name)] = {
          token: minted.token,
          expires_at: minted.expiresAt,
          host: "github.com",
          path: minted.paths.get(String(row.name))!,
        };
      }
    }
    this.entries = entries;
    this.expiries = expiries;
  }

  /** The connection a repository uses, refused unless it is connected. */
  private async connectedLogin(connectionId: string): Promise<Record<string, unknown>> {
    const connection = await this.db.getMcpConnection(connectionId);
    if (connection === null || connection.status !== "connected") {
      const account = String(connection?.account_hint ?? "");
      throw new RepositoryAccessError(`the GitHub connection${account ? ` for ${account}` : ""} is disconnected`);
    }
    return connection;
  }

  /** The login's token for its repositories here. GitHub refusing the installation marks the login disconnected. */
  private async mintCodingToken(
    connection: Record<string, unknown>,
    rows: Array<Record<string, unknown>>,
  ): Promise<RepositoryToken> {
    try {
      return await mintRepositoryToken(
        this.db,
        { connection, repositories: rows, permissions: CODING_PERMISSIONS },
        this.options,
      );
    } catch (error) {
      if (!(error instanceof GithubInstallationGoneError)) {
        throw error;
      }
      await markDisconnected(this.db, connection);
      throw new RepositoryAccessError(
        `GitHub refused the installation for ${loginAccount(connection)}; the connection is now disconnected`,
      );
    }
  }

  /** Writes the agent's tokens under /run/guilds/<agent id> through the sandbox file API, outside every home. */
  async write(files: SandboxFiles, agentId: string): Promise<void> {
    await files.writeFiles([{ path: gitTokensPath(agentId), data: JSON.stringify({ repositories: this.entries }) }]);
  }
}

const CREDENTIAL_FAILURE = /could not read (username|password)|authentication failed|terminal prompts disabled/i;

/**
 * Why each repository failed to clone. When git wanted credentials, says whether the
 * repository had a token git left unused or had none to give.
 */
export function cloneFailures(
  failed: Array<{ name: string; error: string }>,
  repositories: Array<Record<string, unknown>>,
  tokens: Record<string, TokenEntry>,
): string {
  return failed
    .map(({ name, error }) => {
      if (!CREDENTIAL_FAILURE.test(error)) {
        return `${name}: ${error}`;
      }
      if (tokens[name]) {
        return `${name}: git did not use the GitHub token issued for it (${error})`;
      }
      const row = repositories.find((item) => String(item.name) === name);
      if (row && parseGithubUrl(String(row.url)) !== null) {
        return `${name}: it has no GitHub login, so it was cloned without credentials: pick a private repository on the GitHub integration instead (${error})`;
      }
      return `${name}: it was cloned without credentials, which only a public repository allows (${error})`;
    })
    .join("; ");
}
