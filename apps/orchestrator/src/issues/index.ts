import type {
  GuildIssueRow,
  IssueRow,
} from "../db/issues.js";
import { iso, isoOrNull } from "../db/views.js";
import { newId } from "../lib/ids.js";
import { getGuild } from "../db/guilds.js";
import {
  countOpenIssues,
  getIssue,
  insertIssue,
  listIssuesForGuild,
  resolveOpenIssues,
  setIssueStatus,
} from "../db/issues.js";
import { bindQuery, type Queryable } from "../db/pg.js";

export const ISSUE_KINDS = ["tool_failure", "truncated", "api", "other"] as const;
export const ISSUE_SEVERITIES = ["low", "medium", "high"] as const;
export const ISSUE_STATUSES = ["open", "resolved"] as const;
export const ISSUE_SUMMARY_MAX = 200;
export const ISSUE_DETAIL_MAX = 4000;
export const ISSUE_TOOL_NAME_MAX = 120;
export const ISSUE_OPEN_CAP = 100;


/** A refused issue request, with the HTTP status it answers with: 404 for one that does not exist, else 422. */
export class IssueError extends Error {
  status: 404 | 422;

  constructor(message: string, status: 404 | 422 = 422) {
    super(message);
    this.name = "IssueError";
    this.status = status;
  }
}

/** The db/ functions a guild's issues are read and written through, on `db`. */
function issuesDatabase(db: Queryable) {
  return {
    getGuild: bindQuery(db, getGuild),
    insertIssue: bindQuery(db, insertIssue),
    listIssuesForGuild: bindQuery(db, listIssuesForGuild),
    getIssue: bindQuery(db, getIssue),
    setIssueStatus: bindQuery(db, setIssueStatus),
    resolveOpenIssues: bindQuery(db, resolveOpenIssues),
    countOpenIssues: bindQuery(db, countOpenIssues),
  };
}

export type IssuesDatabase = ReturnType<typeof issuesDatabase>;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new IssueError(`${label} must be ${allowed.join(", ")}`);
}

function requiredText(value: unknown, label: string, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new IssueError(`${label} is required`);
  }
  if (text.length > max) {
    throw new IssueError(`${label} is at most ${max} characters`);
  }
  return text;
}

/** The trimmed text, or an empty string when the value is missing or blank. */
function optionalText(value: unknown, label: string, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > max) {
    throw new IssueError(`${label} is at most ${max} characters`);
  }
  return text;
}

function optionalId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  return text || null;
}

/** An issue as the API and the tools show it, with the agent that reported it. */
export type IssueItem = Pick<
  GuildIssueRow,
  | "id"
  | "guild_id"
  | "agent_id"
  | "agent_name"
  | "run_id"
  | "kind"
  | "severity"
  | "status"
  | "summary"
  | "detail"
  | "tool_name"
  | "resolved_by"
> & {
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  agent: { id: string; name: string; avatar_shape: string; avatar_color: string } | null;
};

export function issueItem(row: GuildIssueRow): IssueItem {
  return {
    id: row.id,
    guild_id: row.guild_id,
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    run_id: row.run_id,
    kind: row.kind,
    severity: row.severity,
    status: row.status,
    summary: row.summary,
    detail: row.detail,
    tool_name: row.tool_name,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    resolved_at: isoOrNull(row.resolved_at),
    resolved_by: row.resolved_by,
    agent: row.agent_id
      ? {
          id: row.agent_id,
          name: row.live_agent_name || row.agent_name,
          avatar_shape: row.avatar_shape || "teardrop",
          avatar_color: row.avatar_color || "#7c5cff",
        }
      : null,
  };
}

export class Issues {
  constructor(public db: IssuesDatabase) {}

  async create(args: {
    guildId: string;
    agentId: string;
    agentName: string;
    runId: string;
    kind: unknown;
    severity?: unknown;
    summary: unknown;
    detail: unknown;
    toolName?: unknown;
  }): Promise<IssueRow> {
    const kind = oneOf(args.kind, ISSUE_KINDS, "kind");
    const severity =
      args.severity === undefined || args.severity === null || args.severity === ""
        ? "medium"
        : oneOf(args.severity, ISSUE_SEVERITIES, "severity");
    const summary = requiredText(args.summary, "summary", ISSUE_SUMMARY_MAX);
    const detail = requiredText(args.detail, "detail", ISSUE_DETAIL_MAX);
    const toolName = optionalText(args.toolName, "tool_name", ISSUE_TOOL_NAME_MAX) || null;
    const agentName = requiredText(args.agentName, "agent name", 80);
    const guild = await this.db.getGuild(args.guildId);
    if (guild === null) {
      throw new IssueError("guild not found", 404);
    }
    const open = await this.db.countOpenIssues(args.guildId);
    if (open >= ISSUE_OPEN_CAP) {
      throw new IssueError(
        `this guild already has ${ISSUE_OPEN_CAP} open issues; wait for the operator to resolve some`,
      );
    }
    const now = new Date();
    return this.db.insertIssue(
      {
        issueId: newId("iss"),
        guildId: args.guildId,
        orgId: guild.org_id,
        agentId: optionalId(args.agentId),
        agentName,
        runId: optionalId(args.runId),
        kind,
        severity,
        summary,
        detail,
        toolName,
      },
      now,
    );
  }

  async listForGuild(guildId: string, status?: unknown): Promise<IssueItem[]> {
    let filter: string | null = null;
    if (status !== undefined && status !== null && status !== "" && status !== "all") {
      filter = oneOf(status, ISSUE_STATUSES, "status");
    }
    const rows = await this.db.listIssuesForGuild(guildId, filter);
    return rows.map((row) => issueItem(row));
  }

  async setStatus(
    guildId: string,
    issueId: string,
    status: unknown,
    resolvedBy: string | null,
  ): Promise<IssueItem> {
    const token = (issueId || "").trim();
    if (!token) {
      throw new IssueError("issue_id is required");
    }
    const next = oneOf(status, ISSUE_STATUSES, "status");
    const existing = await this.db.getIssue(guildId, token);
    if (existing === null) {
      throw new IssueError("issue not found", 404);
    }
    const now = new Date();
    const resolvedAt = next === "resolved" ? now : null;
    const resolver = next === "resolved" ? optionalText(resolvedBy ?? "", "resolved_by", 80) || "user" : null;
    const updated = await this.db.setIssueStatus(
      guildId,
      token,
      { status: next, resolvedAt, resolvedBy: resolver },
      now,
    );
    if (updated === null) {
      throw new IssueError("issue not found", 404);
    }
    return issueItem(updated);
  }

  /** Resolves every open issue in the guild. Already-resolved rows stay as they are. */
  async resolveOpen(guildId: string, resolvedBy: string | null): Promise<number> {
    const now = new Date();
    const resolver = optionalText(resolvedBy ?? "", "resolved_by", 80) || "user";
    return this.db.resolveOpenIssues(guildId, now, resolver, now);
  }
}

/** The issues of guilds, read and written on `db`. */
export function guildIssues(db: Queryable): Issues {
  return new Issues(issuesDatabase(db));
}
