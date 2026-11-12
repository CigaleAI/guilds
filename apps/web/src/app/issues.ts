import { issueSeverityLabel, type SegmentedOption } from "@guildsrun/ui";
import { useOpenIssues } from "../api/queries/issues";
import type { Issue, IssueSeverity } from "../api/types/issues";

/** The severities an issue may have, the least severe first. */
export const issueSeverities = [
  "low",
  "medium",
  "high",
  "blocking",
] as const satisfies readonly IssueSeverity[];

/** Whether an issue of `severity` is at least as severe as `floor`. */
export function reachesSeverity(severity: IssueSeverity, floor: IssueSeverity): boolean {
  return issueSeverities.indexOf(severity) >= issueSeverities.indexOf(floor);
}

/** Whether the issue keeps its agent from running: it is open and blocking, and its agent exists. */
export function disablesAgent(issue: Pick<Issue, "status" | "severity" | "agent_id">): boolean {
  return issue.status === "open" && issue.severity === "blocking" && issue.agent_id !== null;
}

/** The issue that disables the agent, the oldest when several do; undefined while none does. */
export function issueDisabling<T extends Issue>(
  agentId: string,
  issues: readonly T[],
): T | undefined {
  return issues
    .filter((issue) => issue.agent_id === agentId && disablesAgent(issue))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
}

/** The open blocking issue that disables the guild's agent; undefined while none does. */
export function useDisablingIssue(guildId: string, agentId: string): Issue | undefined {
  return issueDisabling(agentId, useOpenIssues(guildId).data ?? []);
}

/** Which issues a list shows by severity: every one, or those of one level. */
export type SeverityFilter = "all" | IssueSeverity;

/** The issues the severity filter keeps, in their order. */
export function issuesOfSeverity<T extends Pick<Issue, "severity">>(
  issues: readonly T[],
  filter: SeverityFilter,
): T[] {
  return issues.filter((issue) => filter === "all" || issue.severity === filter);
}

/** The severity filter's choices over `issues`, the most severe first, each with its count. */
export function severityFilterOptions(
  issues: readonly Pick<Issue, "severity">[],
): SegmentedOption<SeverityFilter>[] {
  return [
    { value: "all", label: "All", count: issues.length },
    ...issueSeverities.toReversed().map((severity) => ({
      value: severity,
      label: issueSeverityLabel[severity],
      count: issuesOfSeverity(issues, severity).length,
    })),
  ];
}

/** What each alert severity means to the operator who picks it, as Settings words it. */
export const issueAlertLabel: Record<IssueSeverity, string> = {
  low: "Every issue",
  medium: "Medium and above",
  high: "High and above",
  blocking: "Blocking only",
};
