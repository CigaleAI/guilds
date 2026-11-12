import type { MentionNotice, Notifications } from "../../api/types/chat";
import type { InboxIssue } from "../../api/types/issues";
import { issuesOfSeverity, type SeverityFilter } from "../../app/issues";

export type InboxFilter = "all" | "tags" | "issues";

export type InboxEntry =
  | { kind: "tag"; at: string; notice: MentionNotice }
  | { kind: "issue"; at: string; issue: InboxIssue };

/** The card ground of each kind of entry: blue for a tag, red for an issue. */
export const entryGround: Record<InboxEntry["kind"], string> = {
  tag: "bg-signal-wash",
  issue: "bg-alert-wash",
};

/**
 * The inbox's tags and issues the filters keep, newest first. A severity keeps the issues of that
 * level and no tag, since a tag has none.
 */
export function inboxEntries(
  inbox: Notifications | undefined,
  filter: InboxFilter,
  severity: SeverityFilter,
): InboxEntry[] {
  const tags = filter === "issues" || severity !== "all" ? [] : (inbox?.mentions ?? []);
  const issues = filter === "tags" ? [] : issuesOfSeverity(inbox?.issues ?? [], severity);
  return [
    ...tags.map((notice) => ({ kind: "tag" as const, at: notice.created_at, notice })),
    ...issues.map((issue) => ({ kind: "issue" as const, at: issue.created_at, issue })),
  ].sort((a, b) => b.at.localeCompare(a.at));
}
