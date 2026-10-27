import type { AppDeps } from "./deps.js";

/** Publishes a live event on a guild's group-chat stream, when the box runs a generation loop. */
export async function publishGroup(
  deps: AppDeps,
  guildId: string,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  const chat = deps.generation?.groupChat;
  if (!chat) {
    return;
  }
  await chat.publish(guildId, event, data);
}
