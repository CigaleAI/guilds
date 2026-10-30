import type { GroupMessageRow } from "../db/group-chat.js";
import type { GuildAgentRow } from "../db/agents.js";
import { storedTagAgentIds } from "./tags.js";

/** A public message as the recipient rules read it: where it sits, who wrote it, whom it tags. */
export type RecipientMessage = Pick<
  GroupMessageRow,
  "seq" | "author_type" | "author_agent_id" | "tagged_agent_ids"
>;

/** A guild member as the recipient rules name it. */
export type RecipientMember = Pick<GuildAgentRow, "id" | "name">;

/** The members the messages after `deliveredThrough` tag, leaving out an agent's tag of itself. */
export function taggedRecipientNamesAfter(
  rows: RecipientMessage[],
  members: RecipientMember[],
  deliveredThrough: number,
): Set<string> {
  const membersById = new Map<string, string>();
  for (const member of members) {
    membersById.set(member.id, member.name);
  }
  const recipients = new Set<string>();
  for (const row of rows) {
    if (row.seq <= deliveredThrough) {
      continue;
    }
    const taggedAgentIds = new Set(row.tagged_agent_ids);
    for (const agentId of taggedAgentIds) {
      if (row.author_type === "agent" && agentId === row.author_agent_id) {
        continue;
      }
      const name = membersById.get(agentId);
      if (name !== undefined) {
        recipients.add(name);
      }
    }
  }
  return recipients;
}

export function recipientNamesAfter(
  rows: Array<Record<string, unknown>>,
  members: Array<Record<string, unknown>>,
  deliveredThrough: number,
): Set<string> {
  const membersById = new Map<string, string>();
  for (const member of members) {
    membersById.set(String(member.id), String(member.name));
  }
  const recipients = new Set<string>();
  for (const row of rows) {
    if (Number(row.seq) <= deliveredThrough) {
      continue;
    }
    const taggedAgentIds = new Set(storedTagAgentIds(row));
    let recipientIds: Set<string>;
    if (row.author_type === "user") {
      recipientIds = taggedAgentIds.size ? taggedAgentIds : new Set(membersById.keys());
    } else {
      recipientIds = new Set([...taggedAgentIds].filter((id) => id !== row.author_agent_id));
    }
    for (const agentId of recipientIds) {
      const name = membersById.get(agentId);
      if (name !== undefined) {
        recipients.add(name);
      }
    }
  }
  return recipients;
}
