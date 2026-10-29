import { Type } from "@sinclair/typebox";
import { requireVisibleAgent } from "../agents/access.js";
import { userActor } from "../lib/change-actor.js";
import { requireVisibleGuild } from "../guilds/access.js";
import { scheduleItem } from "../schedules/item.js";
import { scheduleChanges, type ScheduleChanges } from "../schedules/service.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { currentUser } from "./identity.js";
import { AgentParams, GuildParams } from "./params.js";
import { publishGroup } from "./publish.js";

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

/** How a routine change reads on the guild's stream: a pause or resume alone, or an edit. */
function routineAction(changes: ScheduleChanges): string {
  const fields = Object.keys(changes).filter((key) => key !== "paused");
  if (fields.length || changes.paused === undefined) {
    return "edit";
  }
  return changes.paused ? "pause" : "resume";
}

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
      const when = { cron: body.cron, window: body.window };
      const row = await schedules.create(
        userActor(user),
        agent.id,
        when,
        body.description,
        body.instruction,
      );
      await publishGroup(deps, agent.guild_id, "agent.routines.changed", {
        agent_id: agent.id,
        action: "create",
        schedule_id: row.id,
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
      const changes = scheduleChanges(request.body);
      const row = await schedules.update(
        userActor(user),
        agent.id,
        request.params.schedule_id,
        changes,
      );
      await publishGroup(deps, agent.guild_id, "agent.routines.changed", {
        agent_id: agent.id,
        action: routineAction(changes),
        schedule_id: row.id,
      });
      return scheduleItem(row);
    },
  );

  app.delete(
    "/api/agents/:agent_id/schedules/:schedule_id",
    { schema: { params: RoutineParams } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const agent = await requireVisibleAgent(db, request.params.agent_id, user.id);
      const scheduleId = request.params.schedule_id;
      await schedules.delete(userActor(user), agent.id, scheduleId);
      await publishGroup(deps, agent.guild_id, "agent.routines.changed", {
        agent_id: agent.id,
        action: "delete",
        schedule_id: scheduleId,
      });
      return reply.code(204).send();
    },
  );
}
