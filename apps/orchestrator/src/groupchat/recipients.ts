import type { GroupMessageRow } from "../db/group-chat.js";
import type { GuildAgentRow } from "../db/agents.js";

/** A public message as the recipient rules read it: where it sits, who wrote it, whom it tags, and what it replies to. */
export type RecipientMessage = Pick<
  GroupMessageRow,
  "seq" | "author_type" | "author_agent_id" | "tagged_agent_ids"
> &
  Partial<Pick<GroupMessageRow, "reply_to_seq">>;

/** A guild member as the recipient rules name it. */
export type RecipientMember = Pick<GuildAgentRow, "id" | "name">;

/** A target message as reply routing reads it: whether an agent wrote it, and which agent. */
export type ReplyAuthorRow = Pick<RecipientMessage, "author_type" | "author_agent_id">;

function rowsBySequence<R extends Pick<RecipientMessage, "seq">>(rows: readonly R[]): Map<number, R> {
  const bySeq = new Map<number, R>();
  for (const row of rows) {
    bySeq.set(Number(row.seq), row);
  }
  return bySeq;
}

/**
 * The active member ids a public message directly addresses: the members it tags (leaving out an
 * agent's tag of itself), or, for an untagged operator reply to a member agent's post, that agent.
 */
export function addressedAgentIds(
  row: RecipientMessage,
  rowsBySeq: ReadonlyMap<number, ReplyAuthorRow>,
  memberIds: ReadonlySet<string>,
): string[] {
  if (row.author_type === "agent") {
    return row.tagged_agent_ids.filter((id) => id !== row.author_agent_id && memberIds.has(id));
  }
  if (row.tagged_agent_ids.length > 0) {
    return row.tagged_agent_ids.filter((id) => memberIds.has(id));
  }
  const replySeq = row.reply_to_seq;
  if (replySeq === null || replySeq === undefined) {
    return [];
  }
  const target = rowsBySeq.get(Number(replySeq));
  if (target?.author_type === "agent" && target.author_agent_id !== null && memberIds.has(target.author_agent_id)) {
    return [target.author_agent_id];
  }
  return [];
}

/**
 * The members the messages after `deliveredThrough` directly address: by explicit `@` tag (leaving
 * out an agent's tag of itself), or by an untagged operator reply to that member's post.
 */
export function taggedRecipientNamesAfter(
  rows: RecipientMessage[],
  members: RecipientMember[],
  deliveredThrough: number,
): Set<string> {
  const membersById = new Map(members.map((member) => [member.id, member.name]));
  const memberIds = new Set(membersById.keys());
  const bySeq = rowsBySequence(rows);
  const recipients = new Set<string>();
  for (const row of rows) {
    if (row.seq <= deliveredThrough) {
      continue;
    }
    for (const agentId of addressedAgentIds(row, bySeq, memberIds)) {
      const name = membersById.get(agentId);
      if (name !== undefined) {
        recipients.add(name);
      }
    }
  }
  return recipients;
}

/**
 * The members the messages after `deliveredThrough` reach: the members a message directly
 * addresses (by `@` tag or untagged reply to an agent's post), or every member for an operator's
 * message that addresses no specific agent.
 */
export function recipientNamesAfter(
  rows: RecipientMessage[],
  members: RecipientMember[],
  deliveredThrough: number,
): Set<string> {
  const membersById = new Map(members.map((member) => [member.id, member.name]));
  const memberIds = new Set(membersById.keys());
  const bySeq = rowsBySequence(rows);
  const recipients = new Set<string>();
  for (const row of rows) {
    if (row.seq <= deliveredThrough) {
      continue;
    }
    const direct = addressedAgentIds(row, bySeq, memberIds);
    const isDirect = row.tagged_agent_ids.length > 0 || direct.length > 0;
    const recipientIds =
      row.author_type === "user" && !isDirect ? memberIds : new Set(direct);
    for (const agentId of recipientIds) {
      const name = membersById.get(agentId);
      if (name !== undefined) {
        recipients.add(name);
      }
    }
  }
  return recipients;
}
