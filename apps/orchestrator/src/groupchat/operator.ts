import { Type, type Static } from "@sinclair/typebox";
import { getGroupChatSeenThrough, markGroupChatSeen } from "../db/group-chat.js";
import type { Queryable } from "../db/pg.js";
import type { GroupMessageView } from "../db/views.js";
import { GroupChatError, type GroupChat, type MessageAuthor } from "./index.js";

/** What an operator reads and posts a guild's group chat through, built once from the app's services. */
export type GroupChatOperatorServices = {
  db: Queryable;
  /** The guilds' group chat; absent on a box without a generation loop. */
  chat: GroupChat | null;
  /** Tells a user's open inboxes that their unread counts changed. */
  inbox: { ping(userIds: string[]): Promise<void> };
};

/** An operator's message to the group chat, and whether it interrupts the runs it targets. */
export const OperatorMessageSchema = Type.Object({
  content: Type.String(),
  interrupt: Type.Optional(Type.Boolean()),
});

export type OperatorMessage = Static<typeof OperatorMessageSchema>;

/** The guilds' group chat; a box without a generation loop has none (503). */
export function groupChatOf(services: GroupChatOperatorServices): GroupChat {
  if (services.chat === null) {
    throw new GroupChatError(503, "generation is unavailable");
  }
  return services.chat;
}

/** The guild's group chat with how far the user has read it. */
export async function readGroupChat(
  services: GroupChatOperatorServices,
  guildId: string,
  userId: string,
): Promise<Record<string, unknown>> {
  const chat = await groupChatOf(services).state(guildId);
  return { ...chat, seen_through_seq: await getGroupChatSeenThrough(services.db, guildId, userId) };
}

/** Records that the user has read the group chat through message `seq`; it never moves back. */
export async function markGroupChatRead(
  services: GroupChatOperatorServices,
  guildId: string,
  userId: string,
  seq: number,
): Promise<{ seen_through_seq: number }> {
  if (!Number.isInteger(seq) || seq < 0) {
    throw new GroupChatError(422, "seen_through_seq must be a non-negative integer");
  }
  const seen = await markGroupChatSeen(
    services.db,
    { guild_id: guildId, user_id: userId, seen_through_seq: seq },
    new Date(),
  );
  await services.inbox.ping([userId]);
  return { seen_through_seq: seen };
}

/** Posts the operator's message, interrupting the agents it tags when asked; their own message counts as read. */
export async function postOperatorMessage(
  services: GroupChatOperatorServices,
  guildId: string,
  author: MessageAuthor,
  message: OperatorMessage,
): Promise<GroupMessageView> {
  const chat = groupChatOf(services);
  const posted =
    message.interrupt === true
      ? await chat.postUserInterruption(guildId, message.content, author)
      : await chat.postUser(guildId, message.content, author);
  await markGroupChatSeen(
    services.db,
    { guild_id: guildId, user_id: author.id, seen_through_seq: posted.seq },
    new Date(),
  );
  await services.inbox.ping([author.id]);
  return posted;
}
