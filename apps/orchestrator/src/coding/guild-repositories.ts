import { Type, type Static } from "@sinclair/typebox";
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
  GITHUB_SLUG,
  GithubError,
  GithubInstallationGoneError,
  installationRepositories,
  parseGithubUrl,
  requireGithubApp,
  type GithubRepository,
} from "../github/index.js";
import { githubRepositoriesOf } from "../github/repositories.js";
import { installationIdOf, RepositoryAccessError } from "../github/tokens.js";
import { canSeeGuild } from "../guilds/operators.js";
import { GITHUB_SERVER_ID } from "../instance/integrations.js";
import { newId } from "../lib/ids.js";
import {
  DEFAULT_BRANCH,
  githubLoginItem,
  repositoryItem,
  RepositoryValidationError,
  validateGithubRepositories,
  validateRepositoryInput,
} from "./repositories.js";

/** What a guild's repositories and the GitHub logins they use are managed through, built once from the app's services. */
export type RepositoryServices = {
  db: Queryable;
  masterKey: Buffer | undefined;
};

/**
 * GitHub refused the installation behind `connection` while the repositories it reaches were
 * listed. Its caller retires the login, as the message tells the operator.
 */
export class RepositoryListingInstallationGoneError extends RepositoryValidationError {
  readonly connection: McpConnectionRow;

  constructor(connection: McpConnectionRow) {
    super("GitHub refused the installation; the connection is now disconnected");
    this.name = "RepositoryListingInstallationGoneError";
    this.connection = connection;
  }
}

type Item = Record<string, unknown>;

/** A repository's fields as a request sends them, before validation: its name, URL and branch. */
const RepositoryFields = {
  name: Type.String(),
  url: Type.String(),
  default_branch: Type.Optional(Type.Union([Type.String(), Type.Null()])),
};

/** A repository added to a guild, cloned with a GitHub login when `connection_id` names one. */
export const RepositoryDraftSchema = Type.Object({
  ...RepositoryFields,
  connection_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export type RepositoryDraft = Static<typeof RepositoryDraftSchema>;

/** The repositories a GitHub login's coding agents clone, each with GitHub's id when known. */
export const GithubSelectionSchema = Type.Object({
  repositories: Type.Array(
    Type.Object({
      ...RepositoryFields,
      github_id: Type.Optional(Type.Union([Type.Number(), Type.String(), Type.Null()])),
    }),
  ),
});

export type GithubSelection = Static<typeof GithubSelectionSchema>["repositories"];

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

/**
 * Every repository the installation behind a connected GitHub login reaches. An installation
 * GitHub no longer knows throws a `RepositoryListingInstallationGoneError`.
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
      throw new RepositoryListingInstallationGoneError(connection);
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
  body: RepositoryDraft,
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

/** Replaces the repositories a GitHub login picks, among those its installation reaches, and returns them. */
export async function selectGithubRepositories(
  services: RepositoryServices,
  connection: McpConnectionRow,
  repositories: GithubSelection,
  now: Date,
): Promise<GithubRepositorySelection[]> {
  const { db } = services;
  const validated = validateGithubRepositories(repositories);
  const reached = await reachableRepositories(services, connection);
  const selected = matchSelection(validated, reached, repositories);
  if ((await updateMcpConnectionGithubRepositories(db, connection.id, selected, now)) === null) {
    throw new RepositoryValidationError("connection not found", 404);
  }
  return selected;
}

/** Replaces a guild's repositories with the ones its own GitHub login picks; another login changes none. */
export async function replaceLoginGuildRepositories(
  db: Queryable,
  connection: McpConnectionRow,
  selected: GithubRepositorySelection[],
  now: Date,
): Promise<void> {
  if (connection.owner_scope !== "guild" || !connection.owner_id) {
    return;
  }
  const rows = selected.map((item) => ({
    id: newId("repo"),
    name: item.name,
    url: item.url,
    defaultBranch: item.default_branch,
    githubId: item.github_id ?? null,
  }));
  try {
    await replaceConnectionGuildRepositories(
      db,
      { connection_id: connection.id, guild_id: connection.owner_id },
      rows,
      now,
    );
  } catch (error) {
    throw isUniqueViolation(error)
      ? new RepositoryValidationError("a guild repository already uses one of those names", 409)
      : error;
  }
}
