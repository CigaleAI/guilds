import { Type } from "@sinclair/typebox";
import { requireVisibleAgent } from "../agents/access.js";
import { userActor } from "../lib/change-actor.js";
import { requireVisibleGuild } from "../guilds/access.js";
import { scheduleItem } from "../schedules/item.js";
import { createRoutine, deleteRoutine, updateRoutine } from "../schedules/operator.js";
import { scheduleChanges } from "../schedules/service.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { currentUser } from "./identity.js";
import { AgentParams, GuildParams } from "./params.js";

/** A random-wake window: when an agent may wake, in which timezone, and how often at most. */
const WakeWindowSchema = Type.Object({
  timezone: Type.String(),
  start: Type.String(),
  end: Type.String(),
  max_wakes: Type.Number(),
});

/** When a routine runs: a cron expression or a wake window; null is neither. */
const RoutineTimingFields = {
  cron: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  window: Type.Optional(Type.Union([WakeWindowSchema, Type.Null()])),
};

/** A new routine: what it is for, what the agent is told, and when it runs. */
const RoutineDraftSchema = Type.Object({
  description: Type.String(),
  instruction: Type.String(),
  ...RoutineTimingFields,
});

/** A change to a routine; a field left out keeps its value. */
const RoutineChangeSchema = Type.Object({
  description: Type.Optional(Type.String()),
  instruction: Type.Optional(Type.String()),
  paused: Type.Optional(Type.Boolean()),
  ...RoutineTimingFields,
});

/** The path of one routine of an agent. */
const RoutineParams = Type.Object({ agent_id: Type.String(), schedule_id: Type.String() });

/** An agent's routines, and a guild's across its agents. */
export async function registerScheduleRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const { db, schedules } = deps;

  app.get(
    "/api/guilds/:guild_id/schedules",
    { schema: { params: GuildParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const guild = await requireVisibleGuild(db, request.params.guild_id, user.id);
      return schedules.listForGuild(guild.id);
    },
  );

  app.get(
    "/api/agents/:agent_id/schedules",
    { schema: { params: AgentParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const agent = await requireVisibleAgent(db, request.params.agent_id, user.id);
      return schedules.viewsForAgent(agent.id);
    },
  );

  app.post(
    "/api/agents/:agent_id/schedules",
    { schema: { params: AgentParams, body: RoutineDraftSchema } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const agent = await requireVisibleAgent(db, request.params.agent_id, user.id);
      const body = request.body;
      const row = await createRoutine(deps, userActor(user), agent, {
        when: { cron: body.cron, window: body.window },
        description: body.description,
        instruction: body.instruction,
      });
      return reply.code(201).send(scheduleItem(row));
    },
  );

  app.patch(
    "/api/agents/:agent_id/schedules/:schedule_id",
    { schema: { params: RoutineParams, body: RoutineChangeSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const agent = await requireVisibleAgent(db, request.params.agent_id, user.id);
      const routine = { agent, scheduleId: request.params.schedule_id };
      const row = await updateRoutine(deps, userActor(user), routine, scheduleChanges(request.body));
      return scheduleItem(row);
    },
  );

  app.delete(
    "/api/agents/:agent_id/schedules/:schedule_id",
    { schema: { params: RoutineParams } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const agent = await requireVisibleAgent(db, request.params.agent_id, user.id);
      await deleteRoutine(deps, userActor(user), { agent, scheduleId: request.params.schedule_id });
      return reply.code(204).send();
    },
  );
}
