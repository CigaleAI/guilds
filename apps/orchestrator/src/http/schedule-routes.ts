import type { FastifyInstance } from "fastify";
import { requireVisibleAgent } from "../agents/access.js";
import { userActor } from "../lib/change-actor.js";
import { requireVisibleGuild } from "../guilds/access.js";
import { scheduleItem } from "../schedules/item.js";
import { scheduleChanges, type ScheduleChanges } from "../schedules/service.js";
import type { AppDeps } from "./deps.js";
import { missingBodyFields } from "./errors.js";
import { currentUser } from "./identity.js";
import { publishGroup } from "./publish.js";
import { bodyOf, param } from "./request.js";

/** How a routine change reads on the guild's stream: a pause or resume alone, or an edit. */
function routineAction(changes: ScheduleChanges): string {
  const fields = Object.keys(changes).filter((key) => key !== "paused");
  if (fields.length || changes.paused === undefined) {
    return "edit";
  }
  return changes.paused ? "pause" : "resume";
}

/** An agent's routines, and a guild's across its agents. */
export async function registerScheduleRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, schedules } = deps;

  app.get("/api/guilds/:guild_id/schedules", async (request) => {
    const user = await currentUser(db, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), user.id);
    return schedules.listForGuild(guild.id);
  });

  app.get("/api/agents/:agent_id/schedules", async (request) => {
    const user = await currentUser(db, request, deps);
    const agent = await requireVisibleAgent(db, param(request, "agent_id"), user.id);
    return schedules.viewsForAgent(agent.id);
  });

  app.post("/api/agents/:agent_id/schedules", async (request, reply) => {
    const user = await currentUser(db, request, deps);
    const agent = await requireVisibleAgent(db, param(request, "agent_id"), user.id);
    const missing = missingBodyFields(request.body, ["description", "instruction"]);
    if (missing) {
      throw missing;
    }
    const body = bodyOf(request);
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
  });

  app.patch("/api/agents/:agent_id/schedules/:schedule_id", async (request) => {
    const user = await currentUser(db, request, deps);
    const agent = await requireVisibleAgent(db, param(request, "agent_id"), user.id);
    const changes = scheduleChanges(bodyOf(request));
    const row = await schedules.update(
      userActor(user),
      agent.id,
      param(request, "schedule_id"),
      changes,
    );
    await publishGroup(deps, agent.guild_id, "agent.routines.changed", {
      agent_id: agent.id,
      action: routineAction(changes),
      schedule_id: row.id,
    });
    return scheduleItem(row);
  });

  app.delete("/api/agents/:agent_id/schedules/:schedule_id", async (request, reply) => {
    const user = await currentUser(db, request, deps);
    const agent = await requireVisibleAgent(db, param(request, "agent_id"), user.id);
    const scheduleId = param(request, "schedule_id");
    await schedules.delete(userActor(user), agent.id, scheduleId);
    await publishGroup(deps, agent.guild_id, "agent.routines.changed", {
      agent_id: agent.id,
      action: "delete",
      schedule_id: scheduleId,
    });
    return reply.code(204).send();
  });
}
