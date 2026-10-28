import { getMcpServer } from "../connectors/servers.js";
import type { GuildRow } from "../db/guilds.js";
import {
  deleteGuildRepository,
  getGuild,
  insertGuildRepository,
  listGuildRepositories,
  listGuildsForUser,
} from "../db/guilds.js";
import {
  getMcpConnection,
  listVisibleGithubConnections,
  replaceConnectionGuildRepositories,
  updateMcpConnectionGithubRepositories,
  type McpConnectionRow,
} from "../db/mcp.js";
import { getMembership } from "../db/orgs.js";
import { isUniqueViolation, type Queryable } from "../db/pg.js";
import type { GithubRepositorySelection } from "../db/schema/index.js";
import {
  GITHUB_SERVER_ID,
  GITHUB_SLUG,
  GithubError,
  GithubInstallationGoneError,
  installationRepositories,
  parseGithubUrl,
  requireGithubApp,
  type GithubRepository,
} from "../github/index.js";
import { installationIdOf, RepositoryAccessError } from "../github/tokens.js";
import { canSeeGuild } from "../guilds/validation.js";
import { newId } from "../lib/ids.js";
import { markDisconnected, mcpDatabase, type McpPool } from "../mcp/index.js";
import { seesConnection } from "../mcp/visibility.js";
import {
  DEFAULT_BRANCH,
  githubLoginItem,
  githubRepositoriesOf,
  repositoryItem,
  RepositoryValidationError,
  validateGithubRepositories,
  validateRepositoryInput,
} from "./repositories.js";

/** What a guild's repositories and the GitHub logins they use are managed through, built once from the app's services. */
export type RepositoryServices = {
  db: Queryable;
  /** The pool whose tool sessions hold a login's repository-scoped token; absent on a box that calls none. */
  mcp: McpPool | null;
  masterKey: Buffer | undefined;
};

type Item = Record<string, unknown>;

function proxyUrl(): string {
  return process.env.ADAPTER_PROXY_URL ?? "";
}

/** The GitHub login a request names; another connector's login is a 422, none a 404. */
async function requireGithubConnection(
  db: Queryable,
  connectionId: string,
): Promise<McpConnectionRow> {
  const connection = await getMcpConnection(db, connectionId);
  if (connection === null) {
    throw new RepositoryValidationError("connection not found", 404);
  }
  const server = await getMcpServer(db, connection.mcp_server_id);
  if (server?.slug !== GITHUB_SLUG) {
    throw new RepositoryValidationError("connection is not a GitHub connection");
  }
  return connection;
}

/** A GitHub login the user sees and that is not the platform's; any other is a 404. */
export async function requireVisibleGithubConnection(
  db: Queryable,
  connectionId: string,
  userId: string,
): Promise<McpConnectionRow> {
  const connection = await requireGithubConnection(db, connectionId);
  if (connection.owner_scope === "platform" || !(await seesConnection(db, connection, userId))) {
    throw new RepositoryValidationError("connection not found", 404);
  }
  return connection;
}

/**
 * Every repository the installation behind a connected GitHub login reaches. An installation
 * GitHub no longer knows disconnects the login.
 */
export async function reachableRepositories(
  services: RepositoryServices,
  connection: McpConnectionRow,
): Promise<GithubRepository[]> {
  if (connection.status !== "connected") {
    throw new RepositoryValidationError("the GitHub connection is not connected");
  }
  try {
    return await installationRepositories(
      requireGithubApp(),
      installationIdOf(connection, services.masterKey),
      {
        proxyUrl: proxyUrl(),
      },
    );
  } catch (error) {
    if (error instanceof GithubInstallationGoneError) {
      await markDisconnected(mcpDatabase(services.db), connection);
      throw new RepositoryValidationError(
        "GitHub refused the installation; the connection is now disconnected",
      );
    }
    if (error instanceof GithubError || error instanceof RepositoryAccessError) {
      throw new RepositoryValidationError(error.message, 502);
    }
    throw error;
  }
}

/** Whether a guild's repositories may use a login: the organisation's, or one of a guild of it the user sees. */
async function usableFromGuild(
  db: Queryable,
  connection: McpConnectionRow,
  guild: GuildRow,
  userId: string,
): Promise<boolean> {
  if (connection.owner_scope === "org" && connection.owner_id === guild.org_id) {
    return true;
  }
  if (connection.owner_scope !== "guild") {
    return false;
  }
  const owner = await getGuild(db, String(connection.owner_id ?? ""));
  return (
    owner !== null &&
    owner.org_id === guild.org_id &&
    canSeeGuild(owner, userId) &&
    (await getMembership(db, owner.org_id, userId)) !== null
  );
}

/** The repository of the login's reach that a GitHub URL names; one it does not reach is a 422. */
function reachedRepository(reached: GithubRepository[], url: string): GithubRepository {
  const parsed = parseGithubUrl(url);
  const wanted = parsed ? `${parsed.owner}/${parsed.repository}`.toLowerCase() : "";
  const match = reached.find((item) => item.full_name.toLowerCase() === wanted);
  if (!match || !parsed) {
    throw new RepositoryValidationError(
      `the GitHub connection does not reach ${parsed?.owner}/${parsed?.repository}`,
    );
  }
  return match;
}

/** The guild's repositories, and the GitHub logins of the guilds the user sees that they could use. */
export async function listGuildRepositoryView(
  db: Queryable,
  guild: GuildRow,
  userId: string,
): Promise<Item> {
  const visible = await listGuildsForUser(db, guild.org_id, userId);
  const connections = await listVisibleGithubConnections(
    db,
    GITHUB_SERVER_ID,
    guild.org_id,
    visible.map((item) => item.id),
  );
  return {
    repositories: (await listGuildRepositories(db, guild.id)).map(repositoryItem),
    github_connections: connections.map(githubLoginItem),
  };
}

/** Lists a new repository in a guild's own login's selection, when the login is the guild's. */
async function addToGuildLogin(
  db: Queryable,
  guild: GuildRow,
  connectionId: string,
  entry: GithubRepositorySelection,
): Promise<void> {
  const connection = await getMcpConnection(db, connectionId);
  if (
    connection === null ||
    connection.owner_scope !== "guild" ||
    String(connection.owner_id ?? "") !== guild.id
  ) {
    return;
  }
  const current = githubRepositoriesOf(connection);
  if (!current.some((item) => item.name === entry.name)) {
    await updateMcpConnectionGithubRepositories(db, connectionId, [...current, entry], new Date());
  }
}

/**
 * Adds a repository to a guild. One cloned with a GitHub login must be reached by it, from a login
 * the guild may use; it takes the repository's default branch unless the request names one.
 */
export async function addGuildRepository(
  services: RepositoryServices,
  guild: GuildRow,
  userId: string,
  body: Item,
): Promise<Item> {
  const { db } = services;
  const input = validateRepositoryInput(body);
  let defaultBranch = input.defaultBranch;
  let githubId: number | null = null;
  if (input.connectionId !== null) {
    const connection = await requireGithubConnection(db, input.connectionId);
    if (!(await usableFromGuild(db, connection, guild, userId))) {
      throw new RepositoryValidationError("the GitHub connection is not visible from this guild");
    }
    const match = reachedRepository(await reachableRepositories(services, connection), input.url);
    defaultBranch ??= match.default_branch;
    githubId = match.id;
  }
  const branch = defaultBranch ?? DEFAULT_BRANCH;
  const repository = {
    id: newId("repo"),
    guildId: guild.id,
    name: input.name,
    url: input.url,
    defaultBranch: branch,
  };
  try {
    const row = await insertGuildRepository(
      db,
      { ...repository, connectionId: input.connectionId, githubId },
      new Date(),
    );
    if (input.connectionId !== null) {
      const entry = {
        name: input.name,
        url: input.url,
        default_branch: branch,
        ...(githubId === null ? {} : { github_id: githubId }),
      };
      await addToGuildLogin(db, guild, input.connectionId, entry);
    }
    const listed =
      (await listGuildRepositories(db, guild.id)).find((item) => item.id === row.id) ?? row;
    return repositoryItem(listed);
  } catch (error) {
    throw isUniqueViolation(error)
      ? new RepositoryValidationError(`the guild already has a repository named ${input.name}`, 409)
      : error;
  }
}

/** Removes a repository from a guild, and from its own login's selection. */
export async function removeGuildRepository(
  db: Queryable,
  guild: GuildRow,
  repositoryId: string,
): Promise<void> {
  const deleted = await deleteGuildRepository(db, guild.id, repositoryId);
  if (deleted === null) {
    throw new RepositoryValidationError("repository not found", 404);
  }
  const connectionId = deleted.connection_id ?? null;
  const connection = connectionId === null ? null : await getMcpConnection(db, connectionId);
  if (
    connection === null ||
    connection.owner_scope !== "guild" ||
    String(connection.owner_id ?? "") !== guild.id
  ) {
    return;
  }
  const next = githubRepositoriesOf(connection).filter((item) => item.name !== deleted.name);
  await updateMcpConnectionGithubRepositories(db, connection.id, next, new Date());
}

/** The selection with each repository's GitHub id, and its default branch where the request gave none. */
function matchSelection(
  selected: GithubRepositorySelection[],
  reached: GithubRepository[],
  raw: unknown[],
) {
  return selected.map((item, index) => {
    const match = reachedRepository(reached, item.url);
    const given = raw[index];
    const rawBranch =
      given && typeof given === "object" && "default_branch" in given
        ? given.default_branch
        : undefined;
    const keepsBranch =
      rawBranch !== undefined && rawBranch !== null && String(rawBranch).trim() !== "";
    return {
      ...item,
      github_id: match.id,
      ...(keepsBranch ? {} : { default_branch: match.default_branch }),
    };
  });
}

/**
 * Replaces the repositories a GitHub login picks, among those its installation reaches. A guild's
 * own login replaces the guild's repositories with them too.
 */
export async function selectGithubRepositories(
  services: RepositoryServices,
  connection: McpConnectionRow,
  repositories: unknown,
): Promise<{ repositories: GithubRepositorySelection[] }> {
  const { db } = services;
  const validated = validateGithubRepositories(repositories);
  const reached = await reachableRepositories(services, connection);
  const selected = matchSelection(
    validated,
    reached,
    Array.isArray(repositories) ? repositories : [],
  );
  const now = new Date();
  if ((await updateMcpConnectionGithubRepositories(db, connection.id, selected, now)) === null) {
    throw new RepositoryValidationError("connection not found", 404);
  }
  // The login's tool session holds a token scoped to the repositories it picked before.
  services.mcp?.drop(connection.id);
  if (connection.owner_scope !== "guild" || !connection.owner_id) {
    return { repositories: selected };
  }
  const rows = selected.map((item) => ({
    id: newId("repo"),
    name: item.name,
    url: item.url,
    defaultBranch: item.default_branch,
    githubId: item.github_id ?? null,
  }));
  try {
    await replaceConnectionGuildRepositories(db, connection.id, connection.owner_id, rows, now);
  } catch (error) {
    throw isUniqueViolation(error)
      ? new RepositoryValidationError("a guild repository already uses one of those names", 409)
      : error;
  }
  return { repositories: selected };
}
