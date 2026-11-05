import { useLocation } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useNotifications } from "../../api/queries/chat";
import type { Notifications } from "../../api/types/chat";

/** Tab icon while the inbox count is empty, loading, or failed. */
const plainFavicon = "/favicon.svg";
/** Tab icon while the inbox has open issues or unread tags. */
const unreadFavicon = "/favicon-unread.svg";

/** Items waiting in the operator's inbox: open issues plus unread tags. */
export function useInboxCount(): number | undefined {
  const { data } = useNotifications();
  return data ? data.issues.length + data.mentions.length : undefined;
}

/** The tab icon for an inbox count: the dotted mark above zero, otherwise the plain mark. */
export function faviconForInboxCount(count: number | undefined): string {
  if (count === undefined || count <= 0) return plainFavicon;
  return unreadFavicon;
}

function setFavicon(href: string): void {
  document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.setAttribute("href", href);
}

/**
 * Points the tab icon at the inbox count. The shell stays mounted across routes, so a route
 * change applies the icon again. Unmount restores the plain mark.
 */
export function useInboxFavicon(): void {
  const count = useInboxCount();
  const pathname = useLocation({ select: (location) => location.pathname });
  useEffect(() => {
    setFavicon(faviconForInboxCount(count));
  }, [count, pathname]);
  useEffect(() => {
    return () => setFavicon(plainFavicon);
  }, []);
}

/** Unread group chat messages by guild id; a guild with none is absent. */
export function unreadByGuild(inbox: Notifications | undefined): Map<string, number> {
  return new Map((inbox?.unread ?? []).map((chat) => [chat.guild_id, chat.count]));
}

export function useUnreadByGuild(): Map<string, number> {
  const { data } = useNotifications();
  return useMemo(() => unreadByGuild(data), [data]);
}
