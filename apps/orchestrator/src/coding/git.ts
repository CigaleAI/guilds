import { decryptPayload } from "../credentials/crypto.js";
import {
  GithubError,
  GithubInstallationGoneError,
  installationRepositories,
  installationRepository,
  installationToken,
  parseGithubUrl,
  requireGithubApp,
  type GithubAppConfig,
} from "../github/index.js";
import { markDisconnected } from "../mcp/index.js";
import { githubIdOf } from "./repositories.js";
import type { FetchFn } from "../net/http.js";
import type { SandboxFiles } from "../toolbox/types.js";

/** Where an agent's repository tokens are kept in its machine, outside every home. */
export function gitTokensPath(agentId: string): string {
  return `/run/guilds/${agentId}/git-tokens.json`;
}
/** A token closer than this to expiry is replaced before a shell command. */
export const TOKEN_REFRESH_MS = 10 * 60 * 1000;

export class RepositoryAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryAccessError";
  }
}

/** The agent's git identity: its name, and a valid email (guild override or the platform default). */
export function agentGitIdentity(
  agent: Record<string, unknown>,
  options: { email?: string | null } = {},
): { name: string; email: string } {
  const email = typeof options.email === "string" ? options.email.trim() : "";
  return { name: String(agent.name), email: email || `${String(agent.id)}@agents.guilds.run` };
}

export function installationIdOf(connection: Record<string, unknown>, masterKey?: Buffer): number {
  const payload = decryptPayload(connection.ciphertext as Buffer, connection.nonce as Buffer, masterKey);
  const id = Number(payload.installation_id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new RepositoryAccessError("the GitHub connection has no installation");
  }
  return id;
}

export type TokenEntry = { token: string; expires_at: string; host: string; path: string };

export type RepositoryTokenDb = {
  getMcpConnection(connectionId: string): Promise<Record<string, unknown> | null>;
  saveMcpConnection?(
    connectionId: string,
    options: {
      ciphertext: Buffer;
      nonce: Buffer;
      status: string;
      accountHint: string;
      oauthState: string | null;
      now: Date;
    },
  ): Promise<Record<string, unknown> | null>;
  /** Records a repository's GitHub id and its current URL wherever this login lists it. */
  recordGithubRepository?(
    connectionId: string,
    name: string,
    repository: { githubId: number; url: string },
    now: Date,
  ): Promise<void>;
};

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
   * Mints a token for every connection the repositories use, scoped to them by GitHub's ids.
   * A repository with no id recorded finds it by its path, which GitHub follows across a rename.
   * A repository GitHub has renamed, or whose owner it has renamed, gets its current URL, here
   * and where it is stored.
   * A disconnected connection is refused; GitHub refusing the installation marks the
   * connection disconnected.
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
      const connection = await this.db.getMcpConnection(connectionId);
      const account = String(connection?.account_hint ?? "");
      if (connection === null || connection.status !== "connected") {
        throw new RepositoryAccessError(`the GitHub connection${account ? ` for ${account}` : ""} is disconnected`);
      }
      const app = this.options.app ?? requireGithubApp();
      const installationId = installationIdOf(connection, this.options.masterKey);
      const call = { ...(this.options.fetch ? { fetch: this.options.fetch } : {}), now: this.now() };
      const items = rows.map((row) => {
        const parsed = parseGithubUrl(String(row.url));
        if (parsed === null) {
          throw new RepositoryAccessError(`${String(row.name)} is not a GitHub repository URL`);
        }
        return { row, path: `${parsed.owner}/${parsed.repository}` };
      });
      const changed = new Set<(typeof items)[number]>();
      const outOfReach = (missing: typeof items) =>
        new RepositoryAccessError(
          `the GitHub App installed for ${account || connectionId} does not reach ${missing
            .map((item) => `${String(item.row.name)} (${item.path})`)
            .join(", ")}: give the App access to it on GitHub, or pick it again on the GitHub integration`,
        );
      let minted;
      try {
        const unidentified = items.filter((item) => githubIdOf(item.row) === null);
        if (unidentified.length) {
          const { token } = await installationToken(app, installationId, call);
          for (const item of unidentified) {
            const found = await installationRepository(token, item.path, call);
            if (found) {
              item.row.github_id = found.id;
              changed.add(item);
            }
          }
          const missing = unidentified.filter((item) => githubIdOf(item.row) === null);
          if (missing.length) {
            throw outOfReach(missing);
          }
        }
        const repositoryIds = [...new Set(items.map((item) => githubIdOf(item.row)!))];
        try {
          minted = await installationToken(app, installationId, { repositoryIds, ...call });
        } catch (error) {
          // GitHub refuses the whole token when one repository is out of the App's reach.
          if (error instanceof GithubError && !(error instanceof GithubInstallationGoneError) && error.status === 422) {
            const reached = new Set((await installationRepositories(app, installationId, call)).map((item) => item.id));
            const missing = items.filter((item) => !reached.has(githubIdOf(item.row)!));
            if (missing.length) {
              throw outOfReach(missing);
            }
          }
          throw error;
        }
      } catch (error) {
        if (error instanceof GithubInstallationGoneError) {
          if (this.db.saveMcpConnection) {
            await markDisconnected(this.db as never, connection);
          }
          throw new RepositoryAccessError(
            `GitHub refused the installation for ${account || connectionId}; the connection is now disconnected`,
          );
        }
        if (error instanceof GithubError) {
          throw new RepositoryAccessError(error.message);
        }
        throw error;
      }
      expiries.push(Date.parse(minted.expiresAt));
      for (const item of items) {
        const current = minted.repositories.find((repository) => repository.id === githubIdOf(item.row));
        if (current && current.full_name.toLowerCase() !== item.path.toLowerCase()) {
          item.row.url = `https://github.com/${current.full_name}`;
          item.path = current.full_name;
          changed.add(item);
        }
        entries[String(item.row.name)] = {
          token: minted.token,
          expires_at: minted.expiresAt,
          host: "github.com",
          path: item.path,
        };
      }
      for (const item of changed) {
        await this.db.recordGithubRepository?.(
          connectionId,
          String(item.row.name),
          { githubId: githubIdOf(item.row)!, url: String(item.row.url) },
          this.now(),
        );
      }
    }
    this.entries = entries;
    this.expiries = expiries;
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
