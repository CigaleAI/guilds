import { getGroupChatSeenThrough, markGroupChatSeen } from "../db/group-chat.js";
import type { Queryable } from "../db/pg.js";
import { GroupChatError, type GroupChat } from "./index.js";

/** What an operator reads and posts a guild's group chat through, built once from the app's services. */
export type GroupChatOperatorServices = {
  db: Queryable;
  /** The guilds' group chat; absent on a box without a generation loop. */
  chat: GroupChat | null;
  /** Tells a user's open inboxes that their unread counts changed. */
  inbox: { ping(userIds: string[]): Promise<void> };
};

/** An operator's message to the group chat, before validation. */
export type OperatorMessage = { content: string; interrupt: unknown };

/** The operator posting: the user the message is written as. */
export type MessageAuthor = { id: string; name: string };

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
  seq: unknown,
): Promise<{ seen_through_seq: number }> {
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
    throw new GroupChatError(422, "seen_through_seq must be a non-negative integer");
  }
  const seen = await markGroupChatSeen(services.db, guildId, userId, seq, new Date());
  await services.inbox.ping([userId]);
  return { seen_through_seq: seen };
}

/** Posts the operator's message, interrupting the agents it tags when asked; their own message counts as read. */
export async function postOperatorMessage(
  services: GroupChatOperatorServices,
  guildId: string,
  author: MessageAuthor,
  message: OperatorMessage,
): Promise<Record<string, unknown>> {
  if (message.interrupt !== undefined && typeof message.interrupt !== "boolean") {
    throw new GroupChatError(422, "interrupt must be a boolean");
  }
  const posted = await groupChatOf(services).postUser(guildId, message.content, {
    author_name: author.name,
    author_user_id: author.id,
    interrupt: message.interrupt === true,
  });
  await markGroupChatSeen(services.db, guildId, author.id, Number(posted.seq), new Date());
  await services.inbox.ping([author.id]);
  return posted;
}
