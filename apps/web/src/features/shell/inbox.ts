import { useLocation } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useNotifications } from "../../api/queries/chat";
import type { Notifications } from "../../api/types/chat";
import type { InboxIssue, IssueSeverity } from "../../api/types/issues";
import { useIdentity } from "../../app/identity";
import { reachesSeverity } from "../../app/issues";

/** Tab icon while the inbox count is empty, loading, or failed. */
const plainFavicon = "/favicon.svg";
/** Tab icon while the inbox has unread tags or open issues the operator is alerted to. */
const unreadFavicon = "/favicon-unread.svg";

/** The inbox's open issues the operator is alerted to: those at least as severe as `floor`. */
export function alertingIssues(inbox: Notifications, floor: IssueSeverity): InboxIssue[] {
  return inbox.issues.filter((issue) => reachesSeverity(issue.severity, floor));
}

/** Items waiting in the inbox: unread tags plus the open issues at least as severe as `floor`. */
export function inboxCount(inbox: Notifications, floor: IssueSeverity): number {
  return inbox.mentions.length + alertingIssues(inbox, floor).length;
}

/** Items waiting in the operator's inbox: unread tags plus the open issues they are alerted to. */
export function useInboxCount(): number | undefined {
  const { data } = useNotifications();
  const { user } = useIdentity();
  return data ? inboxCount(data, user.issue_alert_severity) : undefined;
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
 * The inbox's tags and its issues at least as severe as `floor`, counted by guild id; a guild
 * with neither is absent. Empty while no guild has such an issue.
 */
export function inboxCountsByGuild(
  inbox: Notifications | undefined,
  floor: IssueSeverity,
): Map<string, GuildInboxCounts> {
  const counts = new Map<string, GuildInboxCounts>();
  const issues = inbox ? alertingIssues(inbox, floor) : [];
  if (!inbox || !issues.length) return counts;
  const countsOf = (guildId: string): GuildInboxCounts => {
    const found = counts.get(guildId);
    if (found) return found;
    const created = { tags: 0, issues: 0 };
    counts.set(guildId, created);
    return created;
  };
  for (const notice of inbox.mentions) countsOf(notice.guild_id).tags += 1;
  for (const issue of issues) countsOf(issue.guild_id).issues += 1;
  return counts;
}

export function useInboxCountsByGuild(): Map<string, GuildInboxCounts> {
  const { data } = useNotifications();
  const floor = useIdentity().user.issue_alert_severity;
  return useMemo(() => inboxCountsByGuild(data, floor), [data, floor]);
}

const noIssues: InboxIssue[] = [];

/** The issues that disable agents in the guilds the operator operates, the oldest first. */
export function useDisablingIssues(): InboxIssue[] {
  return useNotifications().data?.disabling ?? noIssues;
}

/**
 * Who is disabled, in one sentence: the agents by name up to two, their number past that. A name
 * listed twice counts once.
 */
export function disabledAgentsSummary(agentNames: readonly string[]): string {
  const names = [...new Set(agentNames)];
  const [first, second] = names;
  if (first === undefined) return "";
  if (second === undefined) return `${first} is disabled until its blocking issue is resolved`;
  const who = names.length === 2 ? `${first} and ${second}` : `${names.length} agents`;
  return `${who} are disabled until their blocking issues are resolved`;
}

/** The issue that disables each agent, by agent id: the oldest when an agent has several. */
export function disablingIssueByAgent(issues: readonly InboxIssue[]): Map<string, InboxIssue> {
  const byAgent = new Map<string, InboxIssue>();
  for (const issue of issues) {
    if (issue.agent_id !== null && !byAgent.has(issue.agent_id)) byAgent.set(issue.agent_id, issue);
  }
  return byAgent;
}

/** The issue that disables each agent, by agent id, in the guilds the operator operates. */
export function useDisablingIssueByAgent(): Map<string, InboxIssue> {
  const issues = useDisablingIssues();
  return useMemo(() => disablingIssueByAgent(issues), [issues]);
}
