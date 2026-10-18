import { useMemo } from "react";
import { useNotifications } from "../../api/queries";
import type { Notifications } from "../../api/types";

/** Items waiting in the operator's inbox: open issues plus unread tags. */
export function useInboxCount(): number | undefined {
  const { data } = useNotifications();
  return data ? data.issues.length + data.mentions.length : undefined;
}

/** Unread group chat messages by guild id; a guild with none is absent. */
export function unreadByGuild(inbox: Notifications | undefined): Map<string, number> {
  return new Map((inbox?.unread ?? []).map((chat) => [chat.guild_id, chat.count]));
}

export function useUnreadByGuild(): Map<string, number> {
  const { data } = useNotifications();
  return useMemo(() => unreadByGuild(data), [data]);
}
