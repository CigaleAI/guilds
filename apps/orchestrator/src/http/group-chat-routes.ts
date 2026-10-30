import { Type } from "@sinclair/typebox";
import { requireAdministeredGuild, requireVisibleGuild } from "../guilds/access.js";
import {
  groupChatOf,
  markGroupChatRead,
  OperatorMessageSchema,
  postOperatorMessage,
  readGroupChat,
  type GroupChatOperatorServices,
} from "../groupchat/operator.js";
import type { Notifications } from "../notifications/index.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { currentUser } from "./identity.js";
import { GuildParams } from "./params.js";
import { pipeSse } from "./sse.js";

/** The message the user has read the group chat through. */
const ReadCursorSchema = Type.Object({ seen_through_seq: Type.Number() });

/** How many agent messages the group chat takes before it stops waking agents. */
const AgentMessageLimitSchema = Type.Object({ agent_message_limit: Type.Number() });

/** A guild's group chat as its operators read, post and stream it. */
export async function registerGroupChatRoutes(
  app: RouteApp,
  deps: AppDeps,
  notifications: Notifications,
): Promise<void> {
  const { db } = deps;
  const services: GroupChatOperatorServices = {
    db,
    chat: deps.generation?.groupChat ?? null,
    inbox: notifications,
  };

  app.get(
    "/api/guilds/:guild_id/group-chat",
    { schema: { params: GuildParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const guild = await requireVisibleGuild(db, request.params.guild_id, user.id);
      return readGroupChat(services, guild.id, user.id);
    },
  );

  app.put(
    "/api/guilds/:guild_id/group-chat/read",
    { schema: { params: GuildParams, body: ReadCursorSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const guild = await requireVisibleGuild(db, request.params.guild_id, user.id);
      return markGroupChatRead(services, guild.id, user.id, request.body.seen_through_seq);
    },
  );

  app.put(
    "/api/guilds/:guild_id/group-chat",
    { schema: { params: GuildParams, body: AgentMessageLimitSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const guild = await requireVisibleGuild(db, request.params.guild_id, user.id);
      return groupChatOf(services).setLimit(guild.id, request.body.agent_message_limit);
    },
  );

  app.get(
    "/api/guilds/:guild_id/group-chat/messages",
    { schema: { params: GuildParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const guild = await requireVisibleGuild(db, request.params.guild_id, user.id);
      return groupChatOf(services).listMessages(guild.id);
    },
  );

  app.delete(
    "/api/guilds/:guild_id/group-chat/messages",
    { schema: { params: GuildParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const guild = await requireAdministeredGuild(db, request.params.guild_id, user.id);
      return groupChatOf(services).clear(guild.id);
    },
  );

  app.post(
    "/api/guilds/:guild_id/group-chat/messages",
    { schema: { params: GuildParams, body: OperatorMessageSchema } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const guild = await requireVisibleGuild(db, request.params.guild_id, user.id);
      const author = { id: user.id, name: user.name };
      const posted = await postOperatorMessage(services, guild.id, author, request.body);
      return reply.code(202).send(posted);
    },
  );

  app.get(
    "/api/guilds/:guild_id/group-chat/stream",
    { schema: { params: GuildParams } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const guild = await requireVisibleGuild(db, request.params.guild_id, user.id);
      const chat = groupChatOf(services);
      await pipeSse(
        request,
        reply,
        () => chat.subscribe(guild.id),
        (queue) => chat.unsubscribe(guild.id, queue),
      );
    },
  );
}
