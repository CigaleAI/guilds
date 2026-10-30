import type { InferSelectModel } from "drizzle-orm";
import { AgentMessageLimitReached, GroupChatCleared, RowMissing } from "./errors.js";
import { guildVisibleTo } from "./guilds.js";
import { tableColumns } from "./columns.js";
import { type Queryable, stamp, withTransaction } from "./pg.js";
import {
  agents,
  groupChatReads,
  groupMessages,
  guilds,
  type GroupChatFailure,
} from "./schema/index.js";

type Guild = InferSelectModel<typeof guilds>;

export type GroupMessageRow = InferSelectModel<typeof groupMessages>;

/** A guild's chat counters, under the names the group chat reads them by. */
export type GroupChatStateRow = {
  guild_id: Guild["id"];
  chat_seq: Guild["group_chat_seq"];
  agent_message_count: Guild["group_agent_message_count"];
  agent_message_limit: Guild["group_agent_message_limit"];
  errors: Guild["group_chat_errors"];
  pending_agent_count: number;
};

export type ActivityGroupMessageRow = Omit<
  GroupMessageRow,
  "guild_id" | "tagged_agent_ids" | "tagged_user_ids"
>;

export type PendingGroupAgentRow = Pick<
  InferSelectModel<typeof agents>,
  "id" | "guild_id" | "name" | "created_at" | "group_chat_delivered_through"
>;

export type UnreadGroupChatRow = Pick<GroupMessageRow, "guild_id"> & {
  count: number;
};

/** How far a user has read a guild's chat. */
export type GroupChatRead = Pick<
  InferSelectModel<typeof groupChatReads>,
  "guild_id" | "user_id" | "seen_through_seq"
>;

/**
 * The messages an activity span shows: those posted inside [since, until], and the earlier
 * ones after `afterSeq` when it is set.
 */
export type GroupMessageWindow = {
  since: Date;
  until: Date;
  afterSeq: GroupMessageRow["seq"] | null;
};

export type NewUserGroupMessage = {
  guildId: string;
  content: string;
  taggedNames: string[];
  taggedAgentIds: string[];
  taggedUserIds: string[];
  authorName?: string | undefined;
  authorUserId?: string | null | undefined;
};

export type NewAgentGroupMessage = {
  guildId: string;
  agentId: string;
  authorName: string;
  sourceRunId: string;
  content: string;
  taggedNames: string[];
  taggedAgentIds: string[];
  taggedUserIds: string[];
};

const GROUP_MESSAGE_COLUMNS = tableColumns(groupMessages);

export async function getGroupChatState(
  pool: Queryable,
  guildId: string,
): Promise<GroupChatStateRow | null> {
  const result = await pool.query<GroupChatStateRow>(
    `SELECT
       p.id AS guild_id,
       p.group_chat_seq AS chat_seq,
       p.group_agent_message_count AS agent_message_count,
       p.group_agent_message_limit AS agent_message_limit,
       p.group_chat_errors AS errors,
       (
         SELECT COUNT(*)::int
         FROM agents a
         WHERE a.guild_id = p.id
           AND a.group_chat_delivered_through < p.group_chat_seq
       ) AS pending_agent_count
     FROM guilds p
     WHERE p.id = $1`,
    [guildId],
  );
  return result.rows[0] ?? null;
}

export async function updateGroupAgentMessageLimit(
  pool: Queryable,
  guildId: string,
  limit: number,
  now: Date,
): Promise<GroupChatStateRow | null> {
  const updated = await pool.query<{ id: string }>(
    `UPDATE guilds SET group_agent_message_limit = $2, updated_at = $3 WHERE id = $1 RETURNING id`,
    [guildId, limit, stamp(now)],
  );
  if (!updated.rows[0]) {
    return null;
  }
  return getGroupChatState(pool, guildId);
}

/** Where a read of a guild's group transcript stops: at `throughSeq`, or at its end when that is absent. */
export type GroupTranscriptEnd = { throughSeq?: number | null };

export async function listGroupMessages(
  pool: Queryable,
  guildId: string,
  options: GroupTranscriptEnd = {},
): Promise<GroupMessageRow[]> {
  if (options.throughSeq === undefined || options.throughSeq === null) {
    const result = await pool.query<GroupMessageRow>(
      `SELECT ${GROUP_MESSAGE_COLUMNS}
       FROM group_messages WHERE guild_id = $1 ORDER BY seq`,
      [guildId],
    );
    return result.rows;
  }
  const result = await pool.query<GroupMessageRow>(
    `SELECT ${GROUP_MESSAGE_COLUMNS}
     FROM group_messages WHERE guild_id = $1 AND seq <= $2 ORDER BY seq`,
    [guildId, options.throughSeq],
  );
  return result.rows;
}

// Public rows posted inside [since, until], plus every earlier row after
// `afterSeq` so a run that woke on an older message still finds it.
export async function listGroupMessagesForActivity(
  pool: Queryable,
  guildId: string,
  window: GroupMessageWindow,
): Promise<ActivityGroupMessageRow[]> {
  const result = await pool.query<ActivityGroupMessageRow>(
    `SELECT id, seq, author_type, author_name, author_agent_id, author_user_id, source_run_id,
            content, tagged_names, created_at
     FROM group_messages
     WHERE guild_id = $1
       AND created_at <= $3
       AND (created_at >= $2 OR ($4::bigint IS NOT NULL AND seq > $4::bigint))
     ORDER BY seq`,
    [guildId, stamp(window.since), stamp(window.until), window.afterSeq],
  );
  return result.rows;
}

export async function listPendingGroupAgents(
  pool: Queryable,
  guildId: string,
  chatSeq: number,
): Promise<PendingGroupAgentRow[]> {
  const result = await pool.query<PendingGroupAgentRow>(
    `SELECT id, guild_id, name, created_at, group_chat_delivered_through
     FROM agents
     WHERE guild_id = $1 AND group_chat_delivered_through < $2
     ORDER BY group_chat_delivered_through, created_at`,
    [guildId, chatSeq],
  );
  return result.rows;
}

export async function advanceGroupCursor(
  pool: Queryable,
  agentId: string,
  seq: number,
): Promise<void> {
  await pool.query(
    `UPDATE agents
     SET group_chat_delivered_through = GREATEST(group_chat_delivered_through, $2)
     WHERE id = $1`,
    [agentId, seq],
  );
}

// Deletes every public message of the guild. The sequence keeps counting, so
// agent and operator cursors stay valid; each member is caught up to it, the
// agent message count and delivery errors reset, and the clear time stops
// runs that started before it from posting.
export async function clearGroupMessages(
  pool: Queryable,
  guildId: string,
  now: Date,
): Promise<GroupChatStateRow | null> {
  const cleared = await withTransaction(pool, async (client) => {
    const guild = await client.query<{ id: string }>(
      `SELECT id FROM guilds WHERE id = $1 FOR UPDATE`,
      [guildId],
    );
    if (!guild.rows[0]) {
      return false;
    }
    await client.query(`DELETE FROM group_messages WHERE guild_id = $1`, [guildId]);
    await client.query(
      `UPDATE guilds
       SET group_agent_message_count = 0,
           group_chat_errors = '[]'::jsonb,
           group_chat_cleared_at = $2,
           updated_at = $2
       WHERE id = $1`,
      [guildId, stamp(now)],
    );
    await client.query(
      `UPDATE agents a
       SET group_chat_delivered_through = g.group_chat_seq
       FROM guilds g
       WHERE g.id = $1 AND a.guild_id = g.id`,
      [guildId],
    );
    return true;
  });
  return cleared ? getGroupChatState(pool, guildId) : null;
}

// How many public messages this user has not read, per guild they can
// see. A guild they never opened counts every message.
export async function listUnreadGroupChats(
  pool: Queryable,
  orgId: string,
  userId: string,
): Promise<UnreadGroupChatRow[]> {
  const result = await pool.query<UnreadGroupChatRow>(
    `SELECT m.guild_id, COUNT(*)::int AS count
     FROM guilds p
     JOIN group_messages m ON m.guild_id = p.id
     LEFT JOIN group_chat_reads r ON r.guild_id = p.id AND r.user_id = $2
     WHERE p.org_id = $1
       AND ${guildVisibleTo("$2")}
       AND m.seq > COALESCE(r.seen_through_seq, 0)
     GROUP BY m.guild_id
     ORDER BY m.guild_id`,
    [orgId, userId],
  );
  return result.rows;
}

export async function getGroupChatSeenThrough(
  pool: Queryable,
  guildId: string,
  userId: string,
): Promise<number | null> {
  const result = await pool.query<{ seen_through_seq: number }>(
    `SELECT seen_through_seq FROM group_chat_reads WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId],
  );
  return result.rows[0]?.seen_through_seq ?? null;
}

export async function markGroupChatSeen(
  pool: Queryable,
  read: GroupChatRead,
  now: Date,
): Promise<number> {
  const result = await pool.query<{ seen_through_seq: number }>(
    `INSERT INTO group_chat_reads (guild_id, user_id, seen_through_seq, updated_at)
     VALUES ($1, $2, LEAST($3::bigint, (SELECT group_chat_seq FROM guilds WHERE id = $1)), $4)
     ON CONFLICT (guild_id, user_id) DO UPDATE
       SET seen_through_seq = GREATEST(group_chat_reads.seen_through_seq, EXCLUDED.seen_through_seq),
           updated_at = EXCLUDED.updated_at
     RETURNING seen_through_seq`,
    [read.guild_id, read.user_id, read.seen_through_seq, stamp(now)],
  );
  return result.rows[0]?.seen_through_seq ?? 0;
}

export async function appendGroupChatError(
  pool: Queryable,
  guildId: string,
  entry: GroupChatFailure,
  now: Date,
): Promise<GroupChatFailure[]> {
  const result = await pool.query<Pick<Guild, "group_chat_errors">>(
    `UPDATE guilds
     SET group_chat_errors = group_chat_errors || $2::jsonb, updated_at = $3
     WHERE id = $1
     RETURNING group_chat_errors`,
    [guildId, JSON.stringify([entry]), stamp(now)],
  );
  return result.rows[0]?.group_chat_errors ?? [];
}

export async function postUserGroupMessage(
  pool: Queryable,
  message: NewUserGroupMessage,
  now: Date,
): Promise<GroupMessageRow | null> {
  return withTransaction(pool, async (client) => {
    const guild = await client.query<{ id: string }>(
      `SELECT id FROM guilds WHERE id = $1 FOR UPDATE`,
      [message.guildId],
    );
    if (!guild.rows[0]) {
      return null;
    }
    const seqResult = await client.query<{ group_chat_seq: number }>(
      `UPDATE guilds
       SET group_chat_seq = group_chat_seq + 1,
           group_agent_message_count = 0,
           updated_at = $2
       WHERE id = $1
       RETURNING group_chat_seq`,
      [message.guildId, stamp(now)],
    );
    const seq = seqResult.rows[0]?.group_chat_seq;
    if (seq === undefined) {
      throw new RowMissing("group chat sequence update failed");
    }
    const inserted = await client.query<GroupMessageRow>(
      `INSERT INTO group_messages (
         guild_id, seq, author_type, author_name,
         author_agent_id, author_user_id, source_run_id, content, tagged_names,
         tagged_agent_ids, tagged_user_ids, created_at
       )
       VALUES ($1, $2, 'user', $7, NULL, $9, NULL, $3, $4::jsonb, $5::jsonb, $8::jsonb, $6)
       RETURNING ${GROUP_MESSAGE_COLUMNS}`,
      [
        message.guildId,
        seq,
        message.content,
        JSON.stringify(message.taggedNames),
        JSON.stringify(message.taggedAgentIds),
        stamp(now),
        message.authorName ?? "user",
        JSON.stringify(message.taggedUserIds),
        message.authorUserId ?? null,
      ],
    );
    return inserted.rows[0] ?? null;
  });
}

export async function postAgentGroupMessage(
  pool: Queryable,
  message: NewAgentGroupMessage,
  now: Date,
): Promise<GroupMessageRow | null> {
  return withTransaction(pool, async (client) => {
    const guild = await client.query<{
      id: string;
      group_agent_message_count: number;
      group_agent_message_limit: number;
      run_predates_clear: boolean;
    }>(
      `SELECT g.id, g.group_agent_message_count, g.group_agent_message_limit,
              COALESCE(r.created_at < g.group_chat_cleared_at, false) AS run_predates_clear
       FROM guilds g
       LEFT JOIN runs r ON r.id = $2
       WHERE g.id = $1
       FOR UPDATE OF g`,
      [message.guildId, message.sourceRunId],
    );
    const row = guild.rows[0] ?? null;
    if (!row) {
      return null;
    }
    if (row.run_predates_clear === true) {
      throw new GroupChatCleared();
    }
    if (row.group_agent_message_count >= row.group_agent_message_limit) {
      throw new AgentMessageLimitReached(row.group_agent_message_limit);
    }
    const seqResult = await client.query<{ group_chat_seq: number }>(
      `UPDATE guilds
       SET group_chat_seq = group_chat_seq + 1,
           group_agent_message_count = group_agent_message_count + 1,
           updated_at = $2
       WHERE id = $1
       RETURNING group_chat_seq`,
      [message.guildId, stamp(now)],
    );
    const seq = seqResult.rows[0]?.group_chat_seq;
    if (seq === undefined) {
      throw new RowMissing("group chat sequence update failed");
    }
    const inserted = await client.query<GroupMessageRow>(
      `INSERT INTO group_messages (
         guild_id, seq, author_type, author_name,
         author_agent_id, source_run_id, content, tagged_names,
         tagged_agent_ids, tagged_user_ids, created_at
       )
       VALUES ($1, $2, 'agent', $3, $4, $5, $6, $7::jsonb, $8::jsonb, $10::jsonb, $9)
       RETURNING ${GROUP_MESSAGE_COLUMNS}`,
      [
        message.guildId,
        seq,
        message.authorName,
        message.agentId,
        message.sourceRunId,
        message.content,
        JSON.stringify(message.taggedNames),
        JSON.stringify(message.taggedAgentIds),
        stamp(now),
        JSON.stringify(message.taggedUserIds),
      ],
    );
    await client.query(
      `UPDATE agents
       SET group_chat_delivered_through = GREATEST(group_chat_delivered_through, $2)
       WHERE id = $1`,
      [message.agentId, seq],
    );
    return inserted.rows[0] ?? null;
  });
}
