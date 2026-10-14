import type { FastifyInstance } from "fastify";
import { installationIdOf, RepositoryAccessError } from "../coding/git.js";
import {
  HARNESSES,
  HARNESS_INFO,
  harnessLoginOf,
  harnessModelOf,
  harnessOf,
  harnessSecretSource,
  isHarness,
} from "../coding/harnesses.js";
import { cliOf, secretAliasesOf } from "../agents/validation.js";
import { agentSecrets } from "../access/runtime.js";
import {
  DEFAULT_BRANCH,
  githubLoginItem,
  githubRepositoriesOf,
  repositoryItem,
  RepositoryError,
  validateGithubRepositories,
  validateRepositoryInput,
} from "../coding/repositories.js";
import { isUniqueViolation } from "../db/pg.js";
import { jsonObj } from "../db/json.js";
import { RunRequestError } from "../generation/index.js";
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
import { canSeeGuild } from "../guilds/validation.js";
import { newId } from "../lib/ids.js";
import { markDisconnected } from "../mcp/index.js";
import type { AppDeps } from "./deps.js";
import { HttpError } from "./errors.js";
import { currentUser } from "./identity.js";
import { agentConfigObject, ownedAgent, ownedGuild, ownedRun } from "./items.js";
import { bodyOf, param } from "./request.js";

/** The repository a `code_task` result's diff is in, or null when the result has no end checkpoint. */
function taskDiffRepository(metadata: Record<string, unknown> | null): string | null {
  const repository = metadata?.tool_name === "code_task" ? metadata.repository : null;
  return typeof repository === "string" && repository && typeof metadata?.end_sha === "string" ? repository : null;
}

function proxyUrl(): string {
  return process.env.ADAPTER_PROXY_URL ?? "";
}

/**
 * A guild's repositories, the repositories a GitHub connection reaches, and what a
 * coding run changed in each repository.
 */
export async function registerCodingRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { repo } = deps;

  async function githubConnection(id: string): Promise<{ connection: Record<string, unknown> }> {
    const connection = await repo.getMcpConnection(id);
    if (connection === null) {
      throw new HttpError(404, "connection not found");
    }
    const server = await repo.getMcpServer(String(connection.mcp_server_id));
    if (server?.slug !== GITHUB_SLUG) {
      throw new HttpError(422, "connection is not a GitHub connection");
    }
    return { connection };
  }

  /** Every repository the installation behind a connected GitHub login reaches. */
  async function reachable(connection: Record<string, unknown>): Promise<GithubRepository[]> {
    if (connection.status !== "connected") {
      throw new HttpError(422, "the GitHub connection is not connected");
    }
    try {
      return await installationRepositories(requireGithubApp(), installationIdOf(connection, deps.masterKey), {
        proxyUrl: proxyUrl(),
      });
    } catch (error) {
      if (error instanceof GithubInstallationGoneError) {
        await markDisconnected(repo, connection);
        throw new HttpError(422, "GitHub refused the installation; the connection is now disconnected");
      }
      if (error instanceof GithubError || error instanceof RepositoryAccessError) {
        throw new HttpError(502, error.message);
      }
      throw error;
    }
  }

  async function githubConnectionVisible(
    connection: Record<string, unknown>,
    user: Record<string, unknown>,
  ): Promise<boolean> {
    if (connection.owner_scope === "org") {
      return (await repo.getMembership(String(connection.owner_id ?? ""), String(user.id))) !== null;
    }
    if (connection.owner_scope === "guild") {
      const guild = await repo.getGuild(String(connection.owner_id ?? ""));
      return (
        guild !== null &&
        canSeeGuild(guild, String(user.id)) &&
        (await repo.getMembership(String(guild.org_id), String(user.id))) !== null
      );
    }
    if (connection.owner_scope === "agent") {
      const agent = await repo.getAgent(String(connection.owner_id ?? ""));
      if (agent === null) {
        return false;
      }
      const guild = await repo.getGuild(String(agent.guild_id));
      return (
        guild !== null &&
        canSeeGuild(guild, String(user.id)) &&
        (await repo.getMembership(String(guild.org_id), String(user.id))) !== null
      );
    }
    return false;
  }

  async function githubConnectionUsableFromGuild(
    connection: Record<string, unknown>,
    guild: Record<string, unknown>,
    user: Record<string, unknown>,
  ): Promise<boolean> {
    if (connection.owner_scope === "org" && connection.owner_id === guild.org_id) {
      return true;
    }
    if (connection.owner_scope !== "guild") {
      return false;
    }
    const owner = await repo.getGuild(String(connection.owner_id ?? ""));
    return (
      owner !== null &&
      owner.org_id === guild.org_id &&
      canSeeGuild(owner, String(user.id)) &&
      (await repo.getMembership(String(owner.org_id), String(user.id))) !== null
    );
  }

  app.get("/api/guilds/:guild_id/repositories", async (request) => {
    const user = await currentUser(repo, request, deps);
    const guild = await ownedGuild(repo, param(request, "guild_id"), user);
    const visible = await repo.listGuildsForUser(String(guild.org_id), String(user.id));
    const connections = await repo.listVisibleGithubConnections(
      GITHUB_SERVER_ID,
      String(guild.org_id),
      visible.map((item) => String(item.id)),
    );
    return {
      repositories: (await repo.listGuildRepositories(String(guild.id))).map(repositoryItem),
      github_connections: connections.map(githubLoginItem),
    };
  });

  app.post("/api/guilds/:guild_id/repositories", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const guild = await ownedGuild(repo, param(request, "guild_id"), user);
    let input;
    try {
      input = validateRepositoryInput(bodyOf(request));
    } catch (error) {
      if (error instanceof RepositoryError) {
        throw new HttpError(error.status, error.message);
      }
      throw error;
    }
    let defaultBranch = input.defaultBranch;
    let githubId: number | null = null;
    if (input.connectionId !== null) {
      const { connection } = await githubConnection(input.connectionId);
      if (!(await githubConnectionUsableFromGuild(connection, guild, user))) {
        throw new HttpError(422, "the GitHub connection is not visible from this guild");
      }
      const parsed = parseGithubUrl(input.url)!;
      const wanted = `${parsed.owner}/${parsed.repository}`.toLowerCase();
      const match = (await reachable(connection)).find((item) => item.full_name.toLowerCase() === wanted);
      if (!match) {
        throw new HttpError(422, `the GitHub connection does not reach ${parsed.owner}/${parsed.repository}`);
      }
      defaultBranch ??= match.default_branch;
      githubId = match.id;
    }
    try {
      const row = await repo.insertGuildRepository({
        id: newId("repo"),
        guildId: String(guild.id),
        name: input.name,
        url: input.url,
        defaultBranch: defaultBranch ?? DEFAULT_BRANCH,
        connectionId: input.connectionId,
        githubId,
        now: new Date(),
      });
      if (input.connectionId !== null) {
        const connection = await repo.getMcpConnection(input.connectionId);
        if (
          connection !== null &&
          connection.owner_scope === "guild" &&
          String(connection.owner_id ?? "") === String(guild.id)
        ) {
          const current = githubRepositoriesOf(connection);
          if (!current.some((item) => item.name === input.name)) {
            await repo.updateMcpConnectionGithubRepositories(
              input.connectionId,
              [
                ...current,
                {
                  name: input.name,
                  url: input.url,
                  default_branch: defaultBranch ?? DEFAULT_BRANCH,
                  ...(githubId === null ? {} : { github_id: githubId }),
                },
              ],
              new Date(),
            );
          }
        }
      }
      const listed = (await repo.listGuildRepositories(String(guild.id))).find((item) => item.id === row.id) ?? row;
      return reply.code(201).send(repositoryItem(listed));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError(409, `the guild already has a repository named ${input.name}`);
      }
      throw error;
    }
  });

  app.delete("/api/guilds/:guild_id/repositories/:repository_id", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const guild = await ownedGuild(repo, param(request, "guild_id"), user);
    const deleted = await repo.deleteGuildRepository(String(guild.id), param(request, "repository_id"));
    if (deleted === null) {
      throw new HttpError(404, "repository not found");
    }
    const connectionId =
      deleted.connection_id === null || deleted.connection_id === undefined ? null : String(deleted.connection_id);
    if (connectionId !== null) {
      const connection = await repo.getMcpConnection(connectionId);
      if (
        connection !== null &&
        connection.owner_scope === "guild" &&
        String(connection.owner_id ?? "") === String(guild.id)
      ) {
        const next = githubRepositoriesOf(connection).filter((item) => item.name !== String(deleted.name));
        await repo.updateMcpConnectionGithubRepositories(connectionId, next, new Date());
      }
    }
    return reply.code(204).send();
  });

  app.get("/api/mcp/connections/:connection_id/github/repositories", async (request) => {
    const user = await currentUser(repo, request, deps);
    const { connection } = await githubConnection(param(request, "connection_id"));
    if (!(await githubConnectionVisible(connection, user))) {
      throw new HttpError(404, "connection not found");
    }
    return { repositories: await reachable(connection) };
  });

  app.put("/api/mcp/connections/:connection_id/github/selected", async (request) => {
    const user = await currentUser(repo, request, deps);
    const { connection } = await githubConnection(param(request, "connection_id"));
    if (!(await githubConnectionVisible(connection, user))) {
      throw new HttpError(404, "connection not found");
    }
    if (connection.owner_scope === "platform") {
      throw new HttpError(400, "platform-owned credentials cannot be changed here");
    }
    let selected;
    try {
      selected = validateGithubRepositories(bodyOf(request).repositories);
    } catch (error) {
      if (error instanceof RepositoryError) {
        throw new HttpError(error.status, error.message);
      }
      throw error;
    }
    const reached = await reachable(connection);
    const listed = bodyOf(request).repositories;
    const raw = Array.isArray(listed) ? listed : [];
    for (const [index, item] of selected.entries()) {
      const parsed = parseGithubUrl(item.url)!;
      const wanted = `${parsed.owner}/${parsed.repository}`.toLowerCase();
      const match = reached.find((row) => row.full_name.toLowerCase() === wanted);
      if (!match) {
        throw new HttpError(422, `the GitHub connection does not reach ${parsed.owner}/${parsed.repository}`);
      }
      item.github_id = match.id;
      const given = raw[index];
      const rawBranch =
        given && typeof given === "object" && !Array.isArray(given)
          ? (given as { default_branch?: unknown }).default_branch
          : undefined;
      if (rawBranch === undefined || rawBranch === null || String(rawBranch).trim() === "") {
        item.default_branch = match.default_branch;
      }
    }
    const now = new Date();
    const row = await repo.updateMcpConnectionGithubRepositories(String(connection.id), selected, now);
    if (row === null) {
      throw new HttpError(404, "connection not found");
    }
    if (connection.owner_scope === "guild" && connection.owner_id) {
      try {
        await repo.replaceConnectionGuildRepositories(
          String(connection.id),
          String(connection.owner_id),
          selected.map((item) => ({
            id: newId("repo"),
            name: item.name,
            url: item.url,
            defaultBranch: item.default_branch,
            githubId: item.github_id ?? null,
          })),
          now,
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new HttpError(409, "a guild repository already uses one of those names");
        }
        throw error;
      }
    }
    return { repositories: selected };
  });

  app.get("/api/agents/:agent_id/harness", async (request) => {
    const user = await currentUser(repo, request, deps);
    const agent = await ownedAgent(repo, param(request, "agent_id"), user);
    const config = agentConfigObject(agent);
    const cli = cliOf(config);
    const granted = new Set((await agentSecrets(repo, agent)).map((secret) => secret.name));
    const aliases = secretAliasesOf(config);
    const logins = (jsonObj(agent.harness_logins) as Record<string, unknown> | null) ?? {};
    const carried = Array.isArray(agent.machine_harnesses) ? agent.machine_harnesses.filter(isHarness) : null;
    return {
      harness: harnessOf(config),
      harness_model: harnessModelOf(config),
      cli,
      machine_harnesses: carried,
      repositories: (await deps.generation?.codingRepositoryNames(agent)) ?? [],
      harnesses: HARNESSES.map((harness) => {
        const info = HARNESS_INFO[harness];
        const login = harnessLoginOf(logins, harness);
        const source = harnessSecretSource(harness, aliases);
        return {
          harness,
          label: info.label,
          secret: info.secret,
          secret_source: source,
          secret_granted: source !== null && granted.has(source),
          secret_shadowed: source !== null && source !== info.secret && granted.has(String(info.secret)),
          login: cli ? info.login : null,
          login_seen_at: login.seen_at,
          login_account: login.account,
        };
      }),
    };
  });

  app.post("/api/agents/:agent_id/harness/check", async (request) => {
    const user = await currentUser(repo, request, deps);
    const agent = await ownedAgent(repo, param(request, "agent_id"), user);
    const harness = bodyOf(request).harness;
    if (!isHarness(harness)) {
      throw new HttpError(422, `harness must be one of: ${HARNESSES.join(", ")}`);
    }
    if (!deps.generation) {
      throw new HttpError(503, "generation is unavailable");
    }
    try {
      return await deps.generation.checkHarness(String(agent.id), harness);
    } catch (error) {
      if (error instanceof RunRequestError) {
        throw new HttpError(error.status, error.detail);
      }
      throw error;
    }
  });

  app.get("/api/runs/:run_id/changes", async (request) => {
    const user = await currentUser(repo, request, deps);
    const run = await ownedRun(repo, param(request, "run_id"), user);
    const metadata = jsonObj(run.metadata) as Record<string, unknown> | null;
    const repos = metadata && Array.isArray(metadata.repos) ? metadata.repos : [];
    return { repositories: repos };
  });

  app.get("/api/runs/:run_id/tasks/:call_id/diff", async (request) => {
    const user = await currentUser(repo, request, deps);
    const run = await ownedRun(repo, param(request, "run_id"), user);
    const callId = param(request, "call_id");
    const repository = taskDiffRepository(await repo.getToolResultMetadata(String(run.id), callId));
    if (repository === null) {
      throw new HttpError(404, "that call has no task diff");
    }
    if (!deps.generation) {
      throw new HttpError(503, "generation is unavailable");
    }
    try {
      const result = await deps.generation.runDiff(String(run.id), repository, callId);
      return { repository, ...result };
    } catch (error) {
      if (error instanceof RunRequestError) {
        throw new HttpError(error.status, error.detail);
      }
      throw error;
    }
  });

  app.get("/api/runs/:run_id/changes/:repository/diff", async (request) => {
    const user = await currentUser(repo, request, deps);
    const run = await ownedRun(repo, param(request, "run_id"), user);
    const repository = param(request, "repository");
    const metadata = jsonObj(run.metadata) as Record<string, unknown> | null;
    const repos = metadata && Array.isArray(metadata.repos) ? (metadata.repos as Array<Record<string, unknown>>) : [];
    if (!repos.some((item) => item.name === repository)) {
      throw new HttpError(404, "the run changed nothing in that repository");
    }
    if (!deps.generation) {
      throw new HttpError(503, "generation is unavailable");
    }
    try {
      const result = await deps.generation.runDiff(String(run.id), repository);
      return { repository, ...result };
    } catch (error) {
      if (error instanceof RunRequestError) {
        throw new HttpError(error.status, error.detail);
      }
      throw error;
    }
  });
}
