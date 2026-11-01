import type { GuildAgentRow } from "../db/agents.js";
import type { GuildOperatorRow } from "../db/guilds.js";

export const USER_TAG = "user";
export const TAG_RE = /(?<![A-Za-z0-9-])@([a-z][a-z0-9-]{0,62})\b/g;

export function parseTags(content: string, names: Set<string>): string[] {
  const tagged: string[] = [];
  const seen = new Set<string>();
  const matches = (content || "").matchAll(TAG_RE);
  for (const match of matches) {
    const token = match[1];
    if (token && names.has(token) && !seen.has(token)) {
      tagged.push(token);
      seen.add(token);
    }
  }
  return tagged;
}

/** A guild member as a tag names it: its name, and the id the tag selects. */
export type TagMember = Pick<GuildAgentRow, "id" | "name">;

export function taggableNames(
  members: Array<Pick<TagMember, "name">>,
  operators: GuildOperatorRow[] = [],
): Set<string> {
  const names = new Set<string>();
  for (const member of members) {
    names.add(member.name);
  }
  for (const operator of operators) {
    names.add(operator.name);
  }
  names.add(USER_TAG);
  return names;
}

export type GroupTags = { names: string[]; agentIds: string[]; userIds: string[] };

/**
 * Tags in a public message: the names as written, the member agents they
 * select, and the operators they reach. `@user` reaches every operator.
 */
export function recognizedTags(
  content: string,
  members: TagMember[],
  operators: GuildOperatorRow[] = [],
): GroupTags {
  const names = parseTags(content, taggableNames(members, operators));
  const agentIdsByName = new Map<string, string>();
  for (const member of members) {
    agentIdsByName.set(member.name, member.id);
  }
  const agentIds: string[] = [];
  const userIds = new Set<string>();
  for (const name of names) {
    const agentId = agentIdsByName.get(name);
    if (agentId !== undefined) {
      agentIds.push(agentId);
    }
    for (const operator of operators) {
      if (name === USER_TAG || operator.name === name) {
        userIds.add(operator.user_id);
      }
    }
  }
  return { names, agentIds, userIds: [...userIds] };
}
