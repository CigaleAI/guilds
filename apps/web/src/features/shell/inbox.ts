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

/** A guild's entries in the inbox: unread tags and open issues. */
export type GuildInboxCounts = { tags: number; issues: number };

/**
 * The inbox's tags and issues counted by guild id; a guild with neither is absent. Empty while no
 * guild has an open issue.
 */
export function inboxCountsByGuild(
  inbox: Notifications | undefined,
): Map<string, GuildInboxCounts> {
  const counts = new Map<string, GuildInboxCounts>();
  if (!inbox?.issues.length) return counts;
  const countsOf = (guildId: string): GuildInboxCounts => {
    const found = counts.get(guildId);
    if (found) return found;
    const created = { tags: 0, issues: 0 };
    counts.set(guildId, created);
    return created;
  };
  for (const notice of inbox.mentions) countsOf(notice.guild_id).tags += 1;
  for (const issue of inbox.issues) countsOf(issue.guild_id).issues += 1;
  return counts;
}

export function useInboxCountsByGuild(): Map<string, GuildInboxCounts> {
  const { data } = useNotifications();
  return useMemo(() => inboxCountsByGuild(data), [data]);
}
