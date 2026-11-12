import type { MentionNotice, Notifications } from "../../api/types/chat";
import type { Issue } from "../../api/types/issues";

export type InboxFilter = "all" | "tags" | "issues";

export type InboxEntry =
  | { kind: "tag"; at: string; notice: MentionNotice }
  | { kind: "issue"; at: string; issue: Issue & { guild_name: string } };

/** The card ground of each kind of entry: blue for a tag, red for an issue. */
export const entryGround: Record<InboxEntry["kind"], string> = {
  tag: "bg-signal-wash",
  issue: "bg-alert-wash",
};

/** The inbox's tags and issues the filter keeps, newest first. */
export function inboxEntries(
  inbox: Notifications | undefined,
  filter: InboxFilter,
): InboxEntry[] {
  const tags = filter === "issues" ? [] : (inbox?.mentions ?? []);
  const issues = filter === "tags" ? [] : (inbox?.issues ?? []);
  return [
    ...tags.map((notice) => ({ kind: "tag" as const, at: notice.created_at, notice })),
    ...issues.map((issue) => ({ kind: "issue" as const, at: issue.created_at, issue })),
  ].sort((a, b) => b.at.localeCompare(a.at));
}
