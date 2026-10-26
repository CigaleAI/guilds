import { RowMissing } from "./errors.js";
import { markGroupChatSeen } from "./group-chat.js";
import { type Queryable, stamp } from "./pg.js";

export type IssueRow = {
  id: string;
  guild_id: string;
  org_id: string;
  agent_id: string | null;
  agent_name: string;
  run_id: string | null;
  kind: string;
  severity: string;
  status: string;
  summary: string;
  detail: string;
  tool_name: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
};

export type GuildIssueRow = IssueRow & {
  live_agent_name: string | null;
  avatar_shape: string | null;
  avatar_color: string | null;
};

export type InboxIssueRow = GuildIssueRow & {
  guild_name: string;
};

export type InboxMentionRow = {
  id: number;
  guild_id: string;
  seq: number;
  author_type: string;
  author_name: string;
  author_agent_id: string | null;
  content: string;
  created_at: string;
  guild_name: string;
  avatar_shape: string | null;
  avatar_color: string | null;
};

export type NewIssue = {
  issueId: string;
  guildId: string;
  orgId: string;
  agentId: string | null;
  agentName: string;
  runId: string | null;
  kind: string;
  severity: string;
  summary: string;
  detail: string;
  toolName: string | null;
};

/** An issue's status, and when and by whom it was resolved. */
export type IssueStatusChange = {
  status: string;
  resolvedAt: Date | null;
  resolvedBy: string | null;
};

const ISSUE_COLUMNS = `
  id, guild_id, org_id, agent_id, agent_name, run_id, kind, severity, status,
  summary, detail, tool_name, created_at, updated_at, resolved_at, resolved_by
`;

const HYDRATED_ISSUE_COLUMNS = `
  i.id, i.guild_id, i.org_id, i.agent_id, i.agent_name, i.run_id, i.kind,
  i.severity, i.status, i.summary, i.detail, i.tool_name,
  i.created_at, i.updated_at, i.resolved_at, i.resolved_by,
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
  guildId: string,
  issueId: string,
  change: IssueStatusChange,
  now: Date,
): Promise<GuildIssueRow | null> {
  const result = await pool.query<{ id: string }>(
    `UPDATE guild_issues
     SET status = $3, resolved_at = $4, resolved_by = $5, updated_at = $6
     WHERE guild_id = $1 AND id = $2
     RETURNING id`,
    [
      guildId,
      issueId,
      change.status,
      change.resolvedAt ? stamp(change.resolvedAt) : null,
      change.resolvedBy,
      stamp(now),
    ],
  );
  if (!result.rows[0]) {
    return null;
  }
  const hydrated = await getIssue(pool, guildId, issueId);
  if (!hydrated) {
    throw new RowMissing("issue status update failed: the updated issue was not found");
  }
  return hydrated;
}

export async function resolveOpenIssues(
  pool: Queryable,
  guildId: string,
  resolvedAt: Date,
  resolvedBy: string,
  now: Date,
): Promise<number> {
  const result = await pool.query<{ id: string }>(
    `UPDATE guild_issues
     SET status = 'resolved', resolved_at = $2, resolved_by = $3, updated_at = $4
     WHERE guild_id = $1 AND status = 'open'
     RETURNING id`,
    [guildId, stamp(resolvedAt), resolvedBy, stamp(now)],
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
    await markGroupChatSeen(pool, row.guild_id, userId, row.group_chat_seq, now);
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
