import type { FastifyInstance } from "fastify";
import { requireAdministeredGuild, requireVisibleGuild } from "../guilds/access.js";
import {
  groupChatOf,
  markGroupChatRead,
  postOperatorMessage,
  readGroupChat,
  type GroupChatOperatorServices,
} from "../groupchat/operator.js";
import type { Notifications } from "../notifications/index.js";
import type { AppDeps } from "./deps.js";
import { missingBodyFields } from "./errors.js";
import { currentUser } from "./identity.js";
import { identityDatabase } from "../users/identity.js";
import { bodyOf, param } from "./request.js";
import { pipeSse } from "./sse.js";

/** A guild's group chat as its operators read, post and stream it. */
export async function registerGroupChatRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  notifications: Notifications,
): Promise<void> {
  const { db } = deps;
  const identityDb = identityDatabase(db);
  const services: GroupChatOperatorServices = {
    db,
    chat: deps.generation?.groupChat ?? null,
    inbox: notifications,
  };

  app.get("/api/guilds/:guild_id/group-chat", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), user.id);
    return readGroupChat(services, guild.id, user.id);
  });

  app.put("/api/guilds/:guild_id/group-chat/read", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), user.id);
    return markGroupChatRead(services, guild.id, user.id, bodyOf(request).seen_through_seq);
  });

  app.put("/api/guilds/:guild_id/group-chat", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), user.id);
    const limit = Number(bodyOf(request).agent_message_limit);
    return groupChatOf(services).set_limit(guild.id, limit);
  });

  app.get("/api/guilds/:guild_id/group-chat/messages", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), user.id);
    return groupChatOf(services).list_messages(guild.id);
  });

  app.delete("/api/guilds/:guild_id/group-chat/messages", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const guild = await requireAdministeredGuild(db, param(request, "guild_id"), user.id);
    return groupChatOf(services).clear(guild.id);
  });

  app.post("/api/guilds/:guild_id/group-chat/messages", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), user.id);
    const missing = missingBodyFields(request.body, ["content"]);
    if (missing) {
      throw missing;
    }
    const body = bodyOf(request);
    const author = { id: user.id, name: user.name };
    const message = { content: String(body.content ?? ""), interrupt: body.interrupt };
    return reply.code(202).send(await postOperatorMessage(services, guild.id, author, message));
  });

  app.get("/api/guilds/:guild_id/group-chat/stream", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), user.id);
    const chat = groupChatOf(services);
    await pipeSse(
      request,
      reply,
      () => chat.subscribe(guild.id),
      (queue) => chat.unsubscribe(guild.id, queue),
    );
  });
}
