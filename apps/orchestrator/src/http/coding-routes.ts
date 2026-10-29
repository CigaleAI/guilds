import type { FastifyInstance } from "fastify";
import { requireVisibleAgent, requireVisibleRun } from "../agents/access.js";
import {
  addGuildRepository,
  listGuildRepositoryView,
  reachableRepositories,
  removeGuildRepository,
  replaceLoginGuildRepositories,
  RepositoryListingInstallationGoneError,
  selectGithubRepositories,
  type RepositoryServices,
} from "../coding/guild-repositories.js";
import { harnessCatalog } from "../coding/harness-models.js";
import {
  checkAgentHarness,
  listRunChanges,
  loadHarnessView,
  repositoryDiff,
  taskDiff,
  taskLog,
  type RunReviewServices,
} from "../generation/run-review.js";
import { requireVisibleGuild } from "../guilds/access.js";
import { requireVisibleGithubConnection } from "../mcp/connections.js";
import { retireLogin } from "../mcp/service.js";
import { identityDatabase } from "../users/identity.js";
import type { AppDeps } from "./deps.js";
import { currentUser } from "./identity.js";
import { bodyOf, param } from "./request.js";

/**
 * A guild's repositories, the repositories a GitHub connection reaches, and what a
 * coding run changed in each repository. A GitHub login whose installation GitHub refused
 * while its repositories were listed is retired.
 */
export async function registerCodingRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const identityDb = identityDatabase(db);
  const pool = deps.mcp ?? null;
  const repositories: RepositoryServices = { db, masterKey: deps.masterKey };
  const review: RunReviewServices = { db, coding: deps.generation?.coding ?? null };

  app.get("/api/guilds/:guild_id/repositories", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), user.id);
    return listGuildRepositoryView(db, guild, user.id);
  });

  app.post("/api/guilds/:guild_id/repositories", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), user.id);
    try {
      const added = await addGuildRepository(repositories, guild, user.id, bodyOf(request));
      return reply.code(201).send(added);
    } catch (error) {
      if (error instanceof RepositoryListingInstallationGoneError) {
        await retireLogin(pool, db, error.connection, "installation_gone");
      }
      throw error;
    }
  });

  app.delete("/api/guilds/:guild_id/repositories/:repository_id", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), user.id);
    await removeGuildRepository(db, guild, param(request, "repository_id"));
    return reply.code(204).send();
  });

  app.get("/api/mcp/connections/:connection_id/github/repositories", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const connection = await requireVisibleGithubConnection(
      db,
      param(request, "connection_id"),
      user.id,
    );
    try {
      return { repositories: await reachableRepositories(repositories, connection) };
    } catch (error) {
      if (error instanceof RepositoryListingInstallationGoneError) {
        await retireLogin(pool, db, error.connection, "installation_gone");
      }
      throw error;
    }
  });

  app.put("/api/mcp/connections/:connection_id/github/selected", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const connection = await requireVisibleGithubConnection(
      db,
      param(request, "connection_id"),
      user.id,
    );
    const now = new Date();
    try {
      const selected = await selectGithubRepositories(
        repositories,
        connection,
        bodyOf(request).repositories,
        now,
      );
      // The login's tool session holds a token scoped to the repositories it picked before.
      pool?.drop(connection.id);
      await replaceLoginGuildRepositories(db, connection, selected, now);
      return { repositories: selected };
    } catch (error) {
      if (error instanceof RepositoryListingInstallationGoneError) {
        await retireLogin(pool, db, error.connection, "installation_gone");
      }
      throw error;
    }
  });

  app.get("/api/harnesses", async (request) => {
    await currentUser(identityDb, request, deps);
    return { harnesses: harnessCatalog() };
  });

  app.get("/api/agents/:agent_id/harness", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    return loadHarnessView(
      review,
      await requireVisibleAgent(db, param(request, "agent_id"), user.id),
    );
  });

  app.post("/api/agents/:agent_id/harness/check", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const agent = await requireVisibleAgent(db, param(request, "agent_id"), user.id);
    return checkAgentHarness(review, agent, bodyOf(request).harness);
  });

  app.get("/api/runs/:run_id/changes", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    return listRunChanges(await requireVisibleRun(db, param(request, "run_id"), user.id));
  });

  app.get("/api/runs/:run_id/tasks/:call_id/diff", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const run = await requireVisibleRun(db, param(request, "run_id"), user.id);
    return taskDiff(review, run, param(request, "call_id"));
  });

  app.get("/api/runs/:run_id/tasks/:call_id/log", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const run = await requireVisibleRun(db, param(request, "run_id"), user.id);
    return taskLog(review, run, param(request, "call_id"));
  });

  app.get("/api/runs/:run_id/changes/:repository/diff", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const run = await requireVisibleRun(db, param(request, "run_id"), user.id);
    return repositoryDiff(review, run, param(request, "repository"));
  });
}
