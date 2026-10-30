import { Type } from "@sinclair/typebox";
import { requireVisibleAgent, requireVisibleRun } from "../agents/access.js";
import {
  addGuildRepository,
  GithubSelectionSchema,
  RepositoryDraftSchema,
  listGuildRepositoryView,
  pickGithubRepositories,
  reachableRepositories,
  removeGuildRepository,
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
import type { AppDeps, RouteApp } from "./deps.js";
import { currentUser } from "./identity.js";
import { AgentParams, GuildParams } from "./params.js";

/** The path of one repository of a guild. */
const RepositoryParams = Type.Object({ guild_id: Type.String(), repository_id: Type.String() });

/** The path of one login. */
const ConnectionParams = Type.Object({ connection_id: Type.String() });

/** The path of one run. */
const RunParams = Type.Object({ run_id: Type.String() });

/** The path of one coding task of a run. */
const TaskParams = Type.Object({ run_id: Type.String(), call_id: Type.String() });

/** The path of one repository a run changed. */
const RunRepositoryParams = Type.Object({ run_id: Type.String(), repository: Type.String() });

/** The harness a check is run for. */
const HarnessCheckSchema = Type.Object({ harness: Type.Optional(Type.String()) });

/**
 * A guild's repositories, the repositories a GitHub connection reaches, and what a
 * coding run changed in each repository.
 */
export async function registerCodingRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const pool = deps.mcp ?? null;
  const repositories: RepositoryServices = {
    db,
    mcp: pool,
    masterKey: deps.masterKey,
    retireLogin: (connection, failure) => retireLogin(pool, db, connection, failure),
  };
  const review: RunReviewServices = { db, coding: deps.generation?.coding ?? null };

  app.get(
    "/api/guilds/:guild_id/repositories",
    { schema: { params: GuildParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const guild = await requireVisibleGuild(db, request.params.guild_id, user.id);
      return listGuildRepositoryView(db, guild, user.id);
    },
  );

  app.post(
    "/api/guilds/:guild_id/repositories",
    { schema: { params: GuildParams, body: RepositoryDraftSchema } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const guild = await requireVisibleGuild(db, request.params.guild_id, user.id);
      const added = await addGuildRepository(repositories, guild, user.id, request.body);
      return reply.code(201).send(added);
    },
  );

  app.delete(
    "/api/guilds/:guild_id/repositories/:repository_id",
    { schema: { params: RepositoryParams } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const guild = await requireVisibleGuild(db, request.params.guild_id, user.id);
      await removeGuildRepository(db, guild, request.params.repository_id);
      return reply.code(204).send();
    },
  );

  app.get(
    "/api/mcp/connections/:connection_id/github/repositories",
    { schema: { params: ConnectionParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const connectionId = request.params.connection_id;
      const connection = await requireVisibleGithubConnection(db, connectionId, user.id);
      return { repositories: await reachableRepositories(repositories, connection) };
    },
  );

  app.put(
    "/api/mcp/connections/:connection_id/github/selected",
    { schema: { params: ConnectionParams, body: GithubSelectionSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const connectionId = request.params.connection_id;
      const connection = await requireVisibleGithubConnection(db, connectionId, user.id);
      const picked = await pickGithubRepositories(repositories, connection, request.body.repositories);
      return { repositories: picked };
    },
  );

  app.get("/api/harnesses", async (request) => {
    await currentUser(db, request, deps);
    return { harnesses: harnessCatalog() };
  });

  app.get("/api/agents/:agent_id/harness", { schema: { params: AgentParams } }, async (request) => {
    const user = await currentUser(db, request, deps);
    return loadHarnessView(review, await requireVisibleAgent(db, request.params.agent_id, user.id));
  });

  app.post(
    "/api/agents/:agent_id/harness/check",
    { schema: { params: AgentParams, body: HarnessCheckSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const agent = await requireVisibleAgent(db, request.params.agent_id, user.id);
      return checkAgentHarness(review, agent, request.body.harness);
    },
  );

  app.get("/api/runs/:run_id/changes", { schema: { params: RunParams } }, async (request) => {
    const user = await currentUser(db, request, deps);
    return listRunChanges(await requireVisibleRun(db, request.params.run_id, user.id));
  });

  app.get(
    "/api/runs/:run_id/tasks/:call_id/diff",
    { schema: { params: TaskParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const run = await requireVisibleRun(db, request.params.run_id, user.id);
      return taskDiff(review, run, request.params.call_id);
    },
  );

  app.get(
    "/api/runs/:run_id/tasks/:call_id/log",
    { schema: { params: TaskParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const run = await requireVisibleRun(db, request.params.run_id, user.id);
      return taskLog(review, run, request.params.call_id);
    },
  );

  app.get(
    "/api/runs/:run_id/changes/:repository/diff",
    { schema: { params: RunRepositoryParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const run = await requireVisibleRun(db, request.params.run_id, user.id);
      return repositoryDiff(review, run, request.params.repository);
    },
  );
}
