import type { AgentBrief } from "./agents";

/**
 * Shapes of the orchestrator's JSON API for issues, as the app reads them. Timestamps are ISO-8601
 * in UTC.
 */

export type IssueKind = "tool_failure" | "truncated" | "api" | "other";

export type IssueSeverity = "low" | "medium" | "high";

export type IssueStatus = "open" | "resolved";

export type Issue = {
  id: string;
  guild_id: string;
  agent_id: string | null;
  agent_name: string;
  run_id: string | null;
  kind: IssueKind;
  severity: IssueSeverity;
  status: IssueStatus;
  summary: string;
  detail: string;
  tool_name: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  agent: AgentBrief | null;
};

/** An issue resolved or reopened in its guild. */
export type IssueStatusChange = { issueId: string; status: IssueStatus };

/** An issue resolved or reopened, with the guild it is in. */
export type GuildIssueStatusChange = IssueStatusChange & { guildId: string };
