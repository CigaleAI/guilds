import type { InferSelectModel } from "drizzle-orm";
import { tableColumns } from "./columns.js";
import { RowMissing } from "./errors.js";
import { markGroupChatSeen } from "./group-chat.js";
import { type Queryable, stamp } from "./pg.js";
import { agents, groupMessages, guildIssues, guilds } from "./schema/index.js";

type Agent = InferSelectModel<typeof agents>;

export type IssueRow = InferSelectModel<typeof guildIssues>;

/** An issue with its agent's current name and avatar; null once the agent is deleted. */
export type GuildIssueRow = IssueRow & {
  live_agent_name: Agent["name"] | null;
  avatar_shape: Agent["avatar_shape"] | null;
  avatar_color: Agent["avatar_color"] | null;
};

export type InboxIssueRow = GuildIssueRow & {
  guild_name: InferSelectModel<typeof guilds>["name"];
};

export type InboxMentionRow = Pick<
  InferSelectModel<typeof groupMessages>,
  "id" | "guild_id" | "seq" | "author_type" | "author_name" | "author_agent_id" | "content" | "created_at"
> & {
  guild_name: InferSelectModel<typeof guilds>["name"];
  avatar_shape: Agent["avatar_shape"] | null;
  avatar_color: Agent["avatar_color"] | null;
};

export type NewIssue = {
  issueId: string;
  guildId: string;
  orgId: string;
  agentId: string | null;
  agentName: string;
  runId: string | null;
  kind: IssueRow["kind"];
  severity: IssueRow["severity"];
  summary: string;
  detail: string;
  toolName: string | null;
};

/** An issue, by its guild and its id. */
export type IssueKey = Pick<IssueRow, "guild_id" | "id">;

/** An issue's status, and when and by whom it was resolved. */
export type IssueStatusChange = {
  status: IssueRow["status"];
  resolvedAt: Date | null;
  resolvedBy: string | null;
};

const ISSUE_COLUMNS = tableColumns(guildIssues);

const HYDRATED_ISSUE_COLUMNS = `
  ${tableColumns(guildIssues, "i")},
  a.name AS live_agent_name, a.avatar_shape, a.avatar_color
`;

export async function insertIssue(pool: Queryable, issue: NewIssue, now: Date): Promise<IssueRow> {
  const result = await pool.query<IssueRow>(
    `INSERT INTO guild_issues (
       id, guild_id, org_id, agent_id, agent_name, run_id, kind, severity, status,
       summary, detail, tool_name, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9, $10, $11, $12, $12)
     RETURNING ${ISSUE_COLUMNS}`,
    [
      issue.issueId,
      issue.guildId,
      issue.orgId,
      issue.agentId,
      issue.agentName,
      issue.runId,
      issue.kind,
      issue.severity,
      issue.summary,
      issue.detail,
      issue.toolName,
      stamp(now),
    ],
  );
  const row = result.rows[0] ?? null;
  if (!row) {
    throw new RowMissing("issue insert failed");
  }
  return row;
}

export async function listIssuesForGuild(
  pool: Queryable,
  guildId: string,
  status: string | null,
): Promise<GuildIssueRow[]> {
  const result = await pool.query<GuildIssueRow>(
    `SELECT ${HYDRATED_ISSUE_COLUMNS}
     FROM guild_issues i
     LEFT JOIN agents a ON a.id = i.agent_id
     WHERE i.guild_id = $1
       AND ($2::text IS NULL OR i.status = $2)
     ORDER BY CASE i.status WHEN 'open' THEN 0 ELSE 1 END, i.created_at DESC`,
    [guildId, status],
  );
  return result.rows;
}

export async function getIssue(
  pool: Queryable,
  guildId: string,
  issueId: string,
): Promise<GuildIssueRow | null> {
  const result = await pool.query<GuildIssueRow>(
    `SELECT ${HYDRATED_ISSUE_COLUMNS}
     FROM guild_issues i
     LEFT JOIN agents a ON a.id = i.agent_id
     WHERE i.guild_id = $1 AND i.id = $2`,
    [guildId, issueId],
  );
  return result.rows[0] ?? null;
}

/** Sets an issue's status and returns it hydrated; null when the guild has no such issue. */
export async function setIssueStatus(
  pool: Queryable,
  issue: IssueKey,
  change: IssueStatusChange,
  now: Date,
): Promise<GuildIssueRow | null> {
  const result = await pool.query<{ id: string }>(
    `UPDATE guild_issues
     SET status = $3, resolved_at = $4, resolved_by = $5, updated_at = $6
     WHERE guild_id = $1 AND id = $2
     RETURNING id`,
    [
      issue.guild_id,
      issue.id,
      change.status,
      change.resolvedAt ? stamp(change.resolvedAt) : null,
      change.resolvedBy,
      stamp(now),
    ],
  );
  if (!result.rows[0]) {
    return null;
  }
  const hydrated = await getIssue(pool, issue.guild_id, issue.id);
  if (!hydrated) {
    throw new RowMissing("issue status update failed: the updated issue was not found");
  }
  return hydrated;
}

/** Resolves every open issue of the guild in `resolvedBy`'s name at `now`, and counts them. */
export async function resolveOpenIssues(
  pool: Queryable,
  guildId: string,
  resolvedBy: string,
  now: Date,
): Promise<number> {
  const result = await pool.query<{ id: string }>(
    `UPDATE guild_issues
     SET status = 'resolved', resolved_at = $2, resolved_by = $3, updated_at = $2
     WHERE guild_id = $1 AND status = 'open'
     RETURNING id`,
    [guildId, stamp(now), resolvedBy],
  );
  return result.rows.length;
}

// Open issues in the guilds this user operates, newest first.
export async function listInboxIssues(
  pool: Queryable,
  orgId: string,
  userId: string,
  limit: number,
): Promise<InboxIssueRow[]> {
  const result = await pool.query<InboxIssueRow>(
    `SELECT ${HYDRATED_ISSUE_COLUMNS}, p.name AS guild_name
     FROM guild_issues i
     JOIN guild_operators go ON go.guild_id = i.guild_id AND go.user_id = $2
     JOIN guilds p ON p.id = i.guild_id
     LEFT JOIN agents a ON a.id = i.agent_id
     WHERE i.org_id = $1 AND i.status = 'open'
     ORDER BY i.created_at DESC
     LIMIT $3`,
    [orgId, userId, limit],
  );
  return result.rows;
}

// Public messages tagging this user, in guilds they operate, that are past
// their read cursor for that guild. Newest first.
export async function listInboxMentions(
  pool: Queryable,
  orgId: string,
  userId: string,
  limit: number,
): Promise<InboxMentionRow[]> {
  const result = await pool.query<InboxMentionRow>(
    `SELECT m.id, m.guild_id, m.seq, m.author_type, m.author_name, m.author_agent_id,
            m.content, m.created_at, p.name AS guild_name, a.avatar_shape, a.avatar_color
     FROM guild_operators go
     JOIN guilds p ON p.id = go.guild_id
     JOIN group_messages m ON m.guild_id = go.guild_id
     LEFT JOIN group_chat_reads r ON r.guild_id = go.guild_id AND r.user_id = go.user_id
     LEFT JOIN agents a ON a.id = m.author_agent_id
     WHERE go.org_id = $1
       AND go.user_id = $2
       AND m.seq > COALESCE(r.seen_through_seq, 0)
       AND m.tagged_user_ids @> jsonb_build_array($2::text)
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT $3`,
    [orgId, userId, limit],
  );
  return result.rows;
}

// Guilds where this operator has an unread tag. Marks each chat read through
// its current sequence so those tags leave the inbox.
export async function markInboxMentionsRead(
  pool: Queryable,
  orgId: string,
  userId: string,
  now: Date,
): Promise<string[]> {
  const result = await pool.query<{ guild_id: string; group_chat_seq: number }>(
    `SELECT DISTINCT p.id AS guild_id, p.group_chat_seq
     FROM guild_operators go
     JOIN guilds p ON p.id = go.guild_id
     JOIN group_messages m ON m.guild_id = go.guild_id
     LEFT JOIN group_chat_reads r ON r.guild_id = go.guild_id AND r.user_id = go.user_id
     WHERE go.org_id = $1
       AND go.user_id = $2
       AND m.seq > COALESCE(r.seen_through_seq, 0)
       AND m.tagged_user_ids @> jsonb_build_array($2::text)`,
    [orgId, userId],
  );
  const guildIds: string[] = [];
  for (const row of result.rows) {
    await markGroupChatSeen(
      pool,
      { guild_id: row.guild_id, user_id: userId, seen_through_seq: row.group_chat_seq },
      now,
    );
    guildIds.push(row.guild_id);
  }
  return guildIds;
}

export async function countOpenIssues(pool: Queryable, guildId: string): Promise<number> {
  const result = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM guild_issues WHERE guild_id = $1 AND status = 'open'`,
    [guildId],
  );
  return result.rows[0]?.n ?? 0;
}
