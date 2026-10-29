import { Type } from "@sinclair/typebox";
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
import type { AppDeps, RouteApp } from "./deps.js";
import { notesWrite } from "./errors.js";
import { currentOrg, currentUser } from "./identity.js";
import { GuildParams } from "./params.js";
import type { UserRow } from "../db/users.js";

/** Who sees a guild: `org` or `private`; left out or null is `org`. */
const VisibilityField = Type.Optional(Type.Union([Type.String(), Type.Null()]));

/** A new guild: its name, what it is about, and who sees it. */
const GuildDraftSchema = Type.Object({
  name: Type.String(),
  about: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  visibility: VisibilityField,
});

/** A change to a guild's settings; a field left out keeps its value. */
const GuildSettingsSchema = Type.Object({
  name: Type.Optional(Type.String()),
  about: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  max_agents: Type.Optional(Type.Number()),
  git_author_email: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  visibility: VisibilityField,
  routines_enabled: Type.Optional(Type.Boolean()),
});

/** The role a guild operator is given. */
const OperatorRoleSchema = Type.Object({ role: Type.String() });

/** The path of one operator of a guild. */
const OperatorParams = Type.Object({ guild_id: Type.String(), user_id: Type.String() });

function actorOf(user: UserRow): GuildActor {
  return { id: user.id, name: user.name };
}

/** The organisation's guilds, their settings, and their operators. */
export async function registerGuildRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
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

  app.post("/api/guilds", { schema: { body: GuildDraftSchema } }, async (request, reply) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    const body = request.body;
    const draft = {
      name: body.name,
      about: body.about ?? "",
      description: body.description ?? "",
      visibility: body.visibility,
    };
    const scope = { id: String(org.id), slug: String(org.slug) };
    const guild = await notesWrite(createGuild(services, scope, actorOf(user), draft));
    return reply.code(201).send(guildItem(guild));
  });

  app.get("/api/guilds/:guild_id", { schema: { params: GuildParams } }, async (request) => {
    const user = await currentUser(db, request, deps);
    return guildItem(await requireVisibleGuild(db, request.params.guild_id, user.id));
  });

  app.put(
    "/api/guilds/:guild_id",
    { schema: { params: GuildParams, body: GuildSettingsSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const guild = await requireVisibleGuild(db, request.params.guild_id, user.id);
      const body = request.body;
      const patch: GuildSettingsPatch = {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.about !== undefined ? { about: body.about } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.max_agents !== undefined ? { maxAgents: body.max_agents } : {}),
        ...(body.git_author_email !== undefined ? { gitAuthorEmail: body.git_author_email } : {}),
        ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
        ...(body.routines_enabled !== undefined ? { routinesEnabled: body.routines_enabled } : {}),
      };
      const changed = updateGuildSettings(services, guild, actorOf(user), patch);
      return guildItem(await notesWrite(changed));
    },
  );

  app.delete(
    "/api/guilds/:guild_id",
    { schema: { params: GuildParams } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const guild = await requireAdministeredGuild(db, request.params.guild_id, user.id);
      await notesWrite(deleteGuild(services, guild));
      return reply.code(204).send();
    },
  );

  app.put(
    "/api/guilds/:guild_id/operators/:user_id",
    { schema: { params: OperatorParams, body: OperatorRoleSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const guild = await requireAdministeredGuild(db, request.params.guild_id, user.id);
      return guildItem(
        await setOperatorRole(db, guild, request.params.user_id, request.body.role),
      );
    },
  );

  app.delete(
    "/api/guilds/:guild_id/operators/:user_id",
    { schema: { params: OperatorParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const guild = await requireAdministeredGuild(db, request.params.guild_id, user.id);
      return guildItem(await removeOperator(db, guild, request.params.user_id));
    },
  );
}
