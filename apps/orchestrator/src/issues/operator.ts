import type { IssueItem, Issues } from "./index.js";

/** Issues of a guild that changed: the status they were set to, and the one issue, or null for every open one. */
export type IssueChange = { action: string; issueId: string | null };

/** What an operator's issue writes run with: the issues, and the announcement of each change. */
export type IssueWriteDeps = {
  issues: Issues;
  /** Tells the guild that its issues changed; absent on a box with no guild stream. */
  publishIssuesChanged?: (guildId: string, change: IssueChange) => Promise<void>;
};

/** One issue of a guild. */
export type GuildIssue = { guildId: string; issueId: string };

/** Resolves every open issue of the guild, by `resolvedBy`, and announces it when any was open. */
export async function resolveGuildIssues(
  deps: IssueWriteDeps,
  guildId: string,
  resolvedBy: string | null,
): Promise<number> {
  const resolved = await deps.issues.resolveOpen(guildId, resolvedBy);
  if (resolved > 0) {
    await deps.publishIssuesChanged?.(guildId, { action: "resolved", issueId: null });
  }
  return resolved;
}

/** Sets the issue open or resolved, by `resolvedBy`, and announces the status it was set to. */
export async function changeIssueStatus(
  deps: IssueWriteDeps,
  issue: GuildIssue,
  status: string,
  resolvedBy: string | null,
): Promise<IssueItem> {
  const row = await deps.issues.setStatus(issue.guildId, issue.issueId, status, resolvedBy);
  await deps.publishIssuesChanged?.(issue.guildId, { action: status, issueId: row.id });
  return row;
}
