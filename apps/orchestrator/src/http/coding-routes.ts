import type { FastifyInstance } from "fastify";
import { requireVisibleAgent, requireVisibleRun } from "../agents/access.js";
import {
  addGuildRepository,
  listGuildRepositoryView,
  reachableRepositories,
  removeGuildRepository,
  requireVisibleGithubConnection,
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
} from "../coding/run-review.js";
import { requireVisibleGuild } from "../guilds/access.js";
import { identityDatabase } from "../users/identity.js";
import type { AppDeps } from "./deps.js";
import { currentUser } from "./identity.js";
import { bodyOf, param } from "./request.js";

/**
 * A guild's repositories, the repositories a GitHub connection reaches, and what a
 * coding run changed in each repository.
 */
export async function registerCodingRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const identityDb = identityDatabase(db);
  const repositories: RepositoryServices = { db, mcp: deps.mcp ?? null, masterKey: deps.masterKey };
  const review: RunReviewServices = { db, coding: deps.generation?.coding ?? null };

  app.get("/api/guilds/:guild_id/repositories", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), String(user.id));
    return listGuildRepositoryView(db, guild, String(user.id));
  });

  app.post("/api/guilds/:guild_id/repositories", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), String(user.id));
    const added = await addGuildRepository(repositories, guild, String(user.id), bodyOf(request));
    return reply.code(201).send(added);
  });

  app.delete("/api/guilds/:guild_id/repositories/:repository_id", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), String(user.id));
    await removeGuildRepository(db, guild, param(request, "repository_id"));
    return reply.code(204).send();
  });

  app.get("/api/mcp/connections/:connection_id/github/repositories", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const connection = await requireVisibleGithubConnection(
      db,
      param(request, "connection_id"),
      String(user.id),
    );
    return { repositories: await reachableRepositories(repositories, connection) };
  });

  app.put("/api/mcp/connections/:connection_id/github/selected", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const connection = await requireVisibleGithubConnection(
      db,
      param(request, "connection_id"),
      String(user.id),
    );
    return selectGithubRepositories(repositories, connection, bodyOf(request).repositories);
  });

  app.get("/api/harnesses", async (request) => {
    await currentUser(identityDb, request, deps);
    return { harnesses: harnessCatalog() };
  });

  app.get("/api/agents/:agent_id/harness", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    return loadHarnessView(
      review,
      await requireVisibleAgent(db, param(request, "agent_id"), String(user.id)),
    );
  });

  app.post("/api/agents/:agent_id/harness/check", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const agent = await requireVisibleAgent(db, param(request, "agent_id"), String(user.id));
    return checkAgentHarness(review, agent, bodyOf(request).harness);
  });

  app.get("/api/runs/:run_id/changes", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    return listRunChanges(await requireVisibleRun(db, param(request, "run_id"), String(user.id)));
  });

  app.get("/api/runs/:run_id/tasks/:call_id/diff", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const run = await requireVisibleRun(db, param(request, "run_id"), String(user.id));
    return taskDiff(review, run, param(request, "call_id"));
  });

  app.get("/api/runs/:run_id/tasks/:call_id/log", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const run = await requireVisibleRun(db, param(request, "run_id"), String(user.id));
    return taskLog(review, run, param(request, "call_id"));
  });

  app.get("/api/runs/:run_id/changes/:repository/diff", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const run = await requireVisibleRun(db, param(request, "run_id"), String(user.id));
    return repositoryDiff(review, run, param(request, "repository"));
  });
}
