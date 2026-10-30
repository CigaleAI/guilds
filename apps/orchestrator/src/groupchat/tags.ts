import { jsonObj } from "../db/json.js";
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

export function taggableNames(
  members: Array<Record<string, unknown>>,
  operators: GuildOperatorRow[] = [],
): Set<string> {
  const names = new Set<string>();
  for (const member of members) {
    names.add(String(member.name));
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
  members: Array<Record<string, unknown>>,
  operators: GuildOperatorRow[] = [],
): GroupTags {
  const names = parseTags(content, taggableNames(members, operators));
  const agentIdsByName = new Map<string, string>();
  for (const member of members) {
    agentIdsByName.set(String(member.name), String(member.id));
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

export function storedTagAgentIds(row: Record<string, unknown>): string[] {
  const tagged = jsonObj(row.tagged_agent_ids);
  if (!Array.isArray(tagged)) {
    return [];
  }
  return tagged.filter((item): item is string => typeof item === "string");
}
