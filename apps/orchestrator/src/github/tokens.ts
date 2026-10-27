import { githubIdOf, githubRepositoriesOf } from "../coding/repositories.js";
import { decryptPayload } from "../credentials/crypto.js";
import { recordGithubRepository, type McpConnectionRow } from "../db/mcp.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import type { FetchFn } from "../net/http.js";
import {
  GithubError,
  GithubInstallationGoneError,
  installationRepositories,
  installationRepository,
  installationToken,
  parseGithubUrl,
  requireGithubApp,
  type GithubAppConfig,
  type TokenPermissions,
  type TokenRepository,
} from "./index.js";

/** A token closer than this to expiry is replaced before it is used again. */
export const TOKEN_REFRESH_MS = 10 * 60 * 1000;

export class RepositoryAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryAccessError";
  }
}

export function installationIdOf(connection: McpConnectionRow, masterKey?: Buffer): number {
  const payload = decryptPayload(connection.ciphertext, connection.nonce, masterKey);
  const id = Number(payload.installation_id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new RepositoryAccessError("the GitHub connection has no installation");
  }
  return id;
}

/** The name a GitHub login's errors give it: its account, or its id when it has none. */
export function loginAccount(connection: McpConnectionRow): string {
  return String(connection.account_hint ?? "") || connection.id;
}

/** Where minting stores a repository's GitHub id and current URL, on `db`. */
export function githubRepositoryRecorder(db: Queryable) {
  return { recordGithubRepository: bindQuery(db, recordGithubRepository) };
}

export type GithubRepositoryRecorder = ReturnType<typeof githubRepositoryRecorder>;

export type MintOptions = { app?: GithubAppConfig; fetch?: FetchFn; masterKey?: Buffer; now?: () => Date };

/** A GitHub login, the repositories of it a token reaches, and the permissions it holds; none holds every one the installation grants. */
export type RepositoryTokenRequest = {
  connection: McpConnectionRow;
  repositories: Array<Record<string, unknown>>;
  permissions?: TokenPermissions;
};

/** A minted token, when it expires, and each repository's `owner/name` as GitHub names it now, by repository name. */
export type RepositoryToken = { token: string; expiresAt: string; paths: Map<string, string> };

type Item = { row: Record<string, unknown>; path: string };

type InstallationCall = {
  app: GithubAppConfig;
  installationId: number;
  account: string;
  http: { fetch: FetchFn | undefined; now: Date };
};

function outOfReach(account: string, missing: Item[]): RepositoryAccessError {
  return new RepositoryAccessError(
    `the GitHub App installed for ${account} does not reach ${missing
      .map((item) => `${String(item.row.name)} (${item.path})`)
      .join(", ")}: give the App access to it on GitHub, or pick it again on the GitHub integration`,
  );
}

function repositoryItems(rows: Array<Record<string, unknown>>): Item[] {
  return rows.map((row) => {
    const parsed = parseGithubUrl(String(row.url));
    if (parsed === null) {
      throw new RepositoryAccessError(`${String(row.name)} is not a GitHub repository URL`);
    }
    return { row, path: `${parsed.owner}/${parsed.repository}` };
  });
}

/**
 * Gives each repository with no GitHub id the one GitHub lists under its path, and returns
 * those. A repository the installation does not reach under its path is out of reach.
 */
async function identifyRepositories(call: InstallationCall, items: Item[]): Promise<Item[]> {
  const unidentified = items.filter((item) => githubIdOf(item.row) === null);
  if (!unidentified.length) {
    return [];
  }
  const { token } = await installationToken(call.app, call.installationId, call.http);
  for (const item of unidentified) {
    const found = await installationRepository(token, item.path, call.http);
    if (found) {
      item.row.github_id = found.id;
    }
  }
  const missing = unidentified.filter((item) => githubIdOf(item.row) === null);
  if (missing.length) {
    throw outOfReach(call.account, missing);
  }
  return unidentified;
}

/**
 * The error a refused token raises: GitHub refuses the whole token with a 422 when one
 * repository is out of the App's reach, so that refusal names the repositories it does not
 * reach. Any other refusal stays as GitHub gave it.
 */
async function explainRefusal(call: InstallationCall, items: Item[], error: unknown): Promise<unknown> {
  if (!(error instanceof GithubError) || error.status !== 422) {
    return error;
  }
  const reached = new Set((await installationRepositories(call.app, call.installationId, call.http)).map((item) => item.id));
  const missing = items.filter((item) => !reached.has(githubIdOf(item.row)!));
  return missing.length ? outOfReach(call.account, missing) : error;
}

async function mintScopedToken(call: InstallationCall, items: Item[], permissions: TokenPermissions | undefined) {
  const repositoryIds = [...new Set(items.map((item) => githubIdOf(item.row)!))];
  try {
    return await installationToken(call.app, call.installationId, {
      ...call.http,
      repositoryIds,
      ...(permissions ? { permissions } : {}),
    });
  } catch (error) {
    throw await explainRefusal(call, items, error);
  }
}

/** Moves each repository GitHub lists under another name to that name, on its row and its path, and returns those. */
function adoptCurrentNames(items: Item[], repositories: TokenRepository[]): Item[] {
  const moved: Item[] = [];
  for (const item of items) {
    const current = repositories.find((repository) => repository.id === githubIdOf(item.row));
    if (current && current.full_name.toLowerCase() !== item.path.toLowerCase()) {
      item.row.url = `https://github.com/${current.full_name}`;
      item.path = current.full_name;
      moved.push(item);
    }
  }
  return moved;
}

/**
 * An installation token for some of a login's repositories, scoped to them by GitHub's ids.
 * A repository with no id recorded finds it by its path, which GitHub follows across a rename.
 * A repository GitHub has renamed, or whose owner it has renamed, gets its current URL, on its
 * row and where it is stored. GitHub refusing the installation throws
 * `GithubInstallationGoneError`; a repository out of the App's reach, or any other GitHub
 * failure, throws a `RepositoryAccessError`.
 */
export async function mintRepositoryToken(
  db: GithubRepositoryRecorder,
  request: RepositoryTokenRequest,
  options: MintOptions = {},
): Promise<RepositoryToken> {
  const now = options.now?.() ?? new Date();
  const call: InstallationCall = {
    app: options.app ?? requireGithubApp(),
    installationId: installationIdOf(request.connection, options.masterKey),
    account: loginAccount(request.connection),
    http: { fetch: options.fetch, now },
  };
  const items = repositoryItems(request.repositories);
  let identified: Item[];
  let minted;
  try {
    identified = await identifyRepositories(call, items);
    minted = await mintScopedToken(call, items, request.permissions);
  } catch (error) {
    if (error instanceof GithubInstallationGoneError) {
      throw error;
    }
    throw error instanceof GithubError ? new RepositoryAccessError(error.message) : error;
  }
  for (const item of new Set([...identified, ...adoptCurrentNames(items, minted.repositories)])) {
    await db.recordGithubRepository(
      String(request.connection.id),
      String(item.row.name),
      { githubId: githubIdOf(item.row)!, url: String(item.row.url) },
      now,
    );
  }
  return {
    token: minted.token,
    expiresAt: minted.expiresAt,
    paths: new Map(items.map((item) => [String(item.row.name), item.path])),
  };
}

/**
 * An installation token for the repositories a GitHub login picked, holding every permission
 * the installation grants. A login with none picked is refused: a token GitHub mints with no
 * repositories named reaches every repository the installation reaches.
 */
export async function mintLoginToken(
  db: GithubRepositoryRecorder,
  connection: McpConnectionRow,
  options: MintOptions = {},
): Promise<RepositoryToken> {
  const repositories = githubRepositoriesOf(connection);
  if (!repositories.length) {
    throw new RepositoryAccessError(
      `the GitHub login for ${loginAccount(connection)} has no repositories picked: pick them on the GitHub card`,
    );
  }
  return mintRepositoryToken(db, { connection, repositories }, options);
}
