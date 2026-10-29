import { Type } from "@sinclair/typebox";
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
import { loadAgentView } from "../access/view.js";
import { loadOperatorActor } from "../artifacts/actors.js";
import type { AgentRow } from "../db/agents.js";
import { requireVisibleGuild } from "../guilds/access.js";
import { OPEN_POLICY } from "../policy/index.js";
import type { RouteApp, RouteDeps } from "./deps.js";
import { notesWrite } from "./errors.js";
import { currentUser } from "./identity.js";
import { AgentParams, GuildParams } from "./params.js";

/** The machine an agent goes on, by id; null or left out lets the organisation's placement choose. */
const MachineIdField = Type.Optional(Type.Union([Type.String(), Type.Null()]));

/** An agent's profile fields as a request sends them. */
const AgentProfileFields = {
  focus: Type.Optional(Type.String()),
  wake_triggers: Type.Optional(Type.String()),
  avatar_shape: Type.Optional(Type.String()),
  avatar_color: Type.Optional(Type.String()),
  machine_id: MachineIdField,
};

/** A new agent: its name, its config document (checked by the agent's own validation), and its profile. */
const AgentDraftSchema = Type.Object({
  name: Type.String(),
  config: Type.Unknown(),
  ...AgentProfileFields,
});

/** A change to an agent's config and profile; a profile field left out keeps its value. */
const AgentSettingsSchema = Type.Object({
  name: Type.Optional(Type.String()),
  config: Type.Optional(Type.Unknown()),
  ...AgentProfileFields,
});

/** The machine an agent moves to. */
const AgentMachineSchema = Type.Object({ machine_id: MachineIdField });

/** A guild's agents: listed, created, configured, moved between machines, and deleted. */
export async function registerAgentRoutes(app: RouteApp, deps: RouteDeps): Promise<void> {
  const { db } = deps;
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

  app.get("/api/guilds/:guild_id/agents", { schema: { params: GuildParams } }, async (request) => {
    const user = await currentUser(db, request, deps);
    const guild = await requireVisibleGuild(db, request.params.guild_id, user.id);
    return listGuildAgents(services, guild.id);
  });

  app.get(
    "/api/guilds/:guild_id/embed-status",
    { schema: { params: GuildParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const guild = await requireVisibleGuild(db, request.params.guild_id, user.id);
      return { agents: await listBrokenTaskEmbeds(services, guild) };
    },
  );

  app.post(
    "/api/guilds/:guild_id/agents",
    { schema: { params: GuildParams, body: AgentDraftSchema } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const guild = await requireVisibleGuild(db, request.params.guild_id, user.id);
      const body = request.body;
      const draft = {
        name: body.name,
        focus: body.focus ?? "",
        wakeTriggers: body.wake_triggers ?? "",
        avatarShape: body.avatar_shape,
        avatarColor: body.avatar_color,
        config: body.config,
        machineId: body.machine_id,
      };
      const operator = await loadOperatorActor(db, user, { orgId: guild.org_id });
      const agent = await notesWrite(createAgent(services, guild, operator, draft));
      return reply.code(201).send(await viewOf(agent));
    },
  );

  app.get("/api/agents/:agent_id", { schema: { params: AgentParams } }, async (request) => {
    const user = await currentUser(db, request, deps);
    return viewOf(await requireVisibleAgent(db, request.params.agent_id, user.id));
  });

  app.delete(
    "/api/agents/:agent_id",
    { schema: { params: AgentParams } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const agent = await requireVisibleAgent(db, request.params.agent_id, user.id);
      await notesWrite(deleteAgent(services, agent));
      return reply.code(204).send();
    },
  );

  app.put(
    "/api/agents/:agent_id/config",
    { schema: { params: AgentParams, body: AgentSettingsSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const agent = await requireVisibleAgent(db, request.params.agent_id, user.id);
      const body = request.body;
      const patch: AgentSettingsPatch = {
        config: body.config,
        machineId: body.machine_id,
        name: body.name,
        focus: body.focus,
        wakeTriggers: body.wake_triggers,
        avatarShape: body.avatar_shape,
        avatarColor: body.avatar_color,
      };
      return viewOf(await notesWrite(reconfigureAgent(services, agent, user.id, patch)));
    },
  );

  app.put(
    "/api/agents/:agent_id/machine",
    { schema: { params: AgentParams, body: AgentMachineSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const agent = await requireVisibleAgent(db, request.params.agent_id, user.id);
      const machineId = request.body.machine_id;
      return viewOf(await moveAgentToMachine(services, agent, user.id, machineId));
    },
  );
}
