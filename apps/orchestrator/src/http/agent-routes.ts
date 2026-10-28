import type { FastifyInstance } from "fastify";
import { requireVisibleAgent } from "../agents/access.js";
import {
  createAgent,
  deleteAgent,
  listBrokenTaskEmbeds,
  listGuildAgents,
  moveAgentToMachine,
  reconfigureAgent,
  type AgentServices,
  type AgentSettingsPatch,
} from "../agents/service.js";
import { loadAgentView } from "../agents/view.js";
import { loadOperatorActor } from "../artifacts/index.js";
import type { AgentRow } from "../db/agents.js";
import { requireVisibleGuild } from "../guilds/access.js";
import { OPEN_POLICY } from "../policy/index.js";
import type { RouteDeps } from "./deps.js";
import { missingBodyFields, notesWrite } from "./errors.js";
import { currentUser } from "./identity.js";
import { identityDatabase } from "../users/identity.js";
import { bodyOf, param } from "./request.js";

/** A guild's agents: listed, created, configured, moved between machines, and deleted. */
export async function registerAgentRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db } = deps;
  const identityDb = identityDatabase(db);
  const services: AgentServices = {
    db,
    notes: deps.notes,
    artifacts: deps.artifacts,
    policy: deps.policy ?? OPEN_POLICY,
    modelCredentials: deps.modelCredentials,
    generation: deps.generation ?? null,
  };

  async function viewOf(row: AgentRow): Promise<Record<string, unknown>> {
    return loadAgentView(
      db,
      deps.mcp ?? null,
      row,
      deps.generation?.isAgentBusy(row.id) ?? false,
    );
  }

  app.get("/api/guilds/:guild_id/agents", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), user.id);
    return listGuildAgents(services, guild.id);
  });

  app.get("/api/guilds/:guild_id/embed-status", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), user.id);
    return { agents: await listBrokenTaskEmbeds(services, guild) };
  });

  app.post("/api/guilds/:guild_id/agents", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), user.id);
    const missing = missingBodyFields(request.body, ["name", "config"]);
    if (missing) {
      throw missing;
    }
    const body = bodyOf(request);
    const text = (key: string) => (body[key] === undefined ? "" : String(body[key]));
    const draft = {
      name: String(body.name ?? ""),
      focus: text("focus"),
      wakeTriggers: text("wake_triggers"),
      avatarShape: body.avatar_shape === undefined ? undefined : String(body.avatar_shape),
      avatarColor: body.avatar_color === undefined ? undefined : String(body.avatar_color),
      config: body.config,
      machineId: body.machine_id,
    };
    const operator = await loadOperatorActor(db, user, { orgId: guild.org_id });
    const agent = await notesWrite(createAgent(services, guild, operator, draft));
    return reply.code(201).send(await viewOf(agent));
  });

  app.get("/api/agents/:agent_id", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    return viewOf(await requireVisibleAgent(db, param(request, "agent_id"), user.id));
  });

  app.delete("/api/agents/:agent_id", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const agent = await requireVisibleAgent(db, param(request, "agent_id"), user.id);
    await notesWrite(deleteAgent(services, agent));
    return reply.code(204).send();
  });

  app.put("/api/agents/:agent_id/config", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const agent = await requireVisibleAgent(db, param(request, "agent_id"), user.id);
    const body = bodyOf(request);
    const text = (key: string) => (body[key] === undefined ? undefined : String(body[key] ?? ""));
    const avatar = (key: string) => (body[key] === undefined ? undefined : String(body[key]));
    const patch: AgentSettingsPatch = {
      config: body.config,
      machineId: body.machine_id,
      name: text("name"),
      focus: text("focus"),
      wakeTriggers: text("wake_triggers"),
      avatarShape: avatar("avatar_shape"),
      avatarColor: avatar("avatar_color"),
    };
    return viewOf(await notesWrite(reconfigureAgent(services, agent, user.id, patch)));
  });

  app.put("/api/agents/:agent_id/machine", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const agent = await requireVisibleAgent(db, param(request, "agent_id"), user.id);
    const machineId = bodyOf(request).machine_id;
    return viewOf(await moveAgentToMachine(services, agent, user.id, machineId));
  });
}
