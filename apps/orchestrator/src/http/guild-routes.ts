import type { FastifyInstance } from "fastify";
import { requireAdministeredGuild, requireVisibleGuild } from "../guilds/access.js";
import { removeOperator, setOperatorRole } from "../guilds/operators.js";
import {
  createGuild,
  deleteGuild,
  guildItem,
  listUserGuilds,
  updateGuildSettings,
  type GuildActor,
  type GuildServices,
  type GuildSettingsPatch,
} from "../guilds/service.js";
import { OPEN_POLICY } from "../policy/index.js";
import type { AppDeps } from "./deps.js";
import { missingBodyFields, notesWrite } from "./errors.js";
import { currentOrg, currentUser } from "./identity.js";
import { bodyOf, param } from "./request.js";
import type { UserRow } from "../db/users.js";

function actorOf(user: UserRow): GuildActor {
  return { id: user.id, name: user.name };
}

/** The organisation's guilds, their settings, and their operators. */
export async function registerGuildRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const services: GuildServices = {
    db,
    notes: deps.notes,
    policy: deps.policy ?? OPEN_POLICY,
    schedules: deps.schedules,
    generation: deps.generation ?? null,
  };

  app.get("/api/guilds", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    return (await listUserGuilds(db, String(org.id), user.id)).map(guildItem);
  });

  app.post("/api/guilds", async (request, reply) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    const missing = missingBodyFields(request.body, ["name"]);
    if (missing) {
      throw missing;
    }
    const body = bodyOf(request);
    const draft = {
      name: String(body.name ?? ""),
      about: body.about === undefined ? "" : String(body.about),
      description: body.description === undefined ? "" : String(body.description),
      visibility: body.visibility,
    };
    const scope = { id: String(org.id), slug: String(org.slug) };
    const guild = await notesWrite(createGuild(services, scope, actorOf(user), draft));
    return reply.code(201).send(guildItem(guild));
  });

  app.get("/api/guilds/:guild_id", async (request) => {
    const user = await currentUser(db, request, deps);
    return guildItem(await requireVisibleGuild(db, param(request, "guild_id"), user.id));
  });

  app.put("/api/guilds/:guild_id", async (request) => {
    const user = await currentUser(db, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), user.id);
    const body = bodyOf(request);
    const text = (key: string) =>
      body[key] === undefined ? {} : { [key]: String(body[key] ?? "") };
    const patch: GuildSettingsPatch = {
      ...text("name"),
      ...text("about"),
      ...text("description"),
      maxAgents: body.max_agents,
      gitAuthorEmail: body.git_author_email,
      visibility: body.visibility,
      routinesEnabled: body.routines_enabled,
    };
    return guildItem(await notesWrite(updateGuildSettings(services, guild, actorOf(user), patch)));
  });

  app.delete("/api/guilds/:guild_id", async (request, reply) => {
    const user = await currentUser(db, request, deps);
    const guild = await requireAdministeredGuild(db, param(request, "guild_id"), user.id);
    await notesWrite(deleteGuild(services, guild));
    return reply.code(204).send();
  });

  app.put("/api/guilds/:guild_id/operators/:user_id", async (request) => {
    const user = await currentUser(db, request, deps);
    const guild = await requireAdministeredGuild(db, param(request, "guild_id"), user.id);
    return guildItem(
      await setOperatorRole(db, guild, param(request, "user_id"), bodyOf(request).role),
    );
  });

  app.delete("/api/guilds/:guild_id/operators/:user_id", async (request) => {
    const user = await currentUser(db, request, deps);
    const guild = await requireAdministeredGuild(db, param(request, "guild_id"), user.id);
    return guildItem(await removeOperator(db, guild, param(request, "user_id")));
  });
}
