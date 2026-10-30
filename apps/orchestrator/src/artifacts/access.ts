import { Type, type Static } from "@sinclair/typebox";
import { isPlainRecord } from "../db/json.js";
import { ArtifactError } from "./errors.js";
import {
  isAccessMode,
  isAccessSubject,
  isAgentAccessMode,
  type AccessGrant,
  type AccessSubjectRef,
  type AgentAccessMode,
  type ArtifactLevel,
} from "./types.js";
import type { AccessMode } from "../db/schema/index.js";

/** A mode read back from SQL: `read` or `write`, null for `none` or no row. */
export function reachedMode(value: unknown): AccessMode | null {
  return isAccessMode(value) ? value : null;
}

/**
 * The rows a new item starts with: a guild's item is written by its guild,
 * an organisation's item read by the organisation, an agent's item reached by
 * its agent alone.
 */
export function defaultGrants(level: ArtifactLevel, ownerId: string): AccessGrant[] {
  if (level === "guild") {
    return [{ type: "guild", id: ownerId, mode: "write" }];
  }
  if (level === "org") {
    return [{ type: "org", id: ownerId, mode: "read" }];
  }
  return [];
}

/** Whether the default rows of a new item at `level` let a non-operator writer write it. */
export function createsWritable(level: ArtifactLevel): boolean {
  return level === "agent" || defaultGrants(level, "").some((grant) => grant.mode === "write");
}

/**
 * One validated grant from the operator; `none` belongs to agents alone.
 * `where` prefixes each error, naming the grant's place in a list.
 */
export function parseGrant(value: unknown, where = ""): AccessGrant {
  const item: Record<string, unknown> = isPlainRecord(value) ? value : {};
  if (!isAccessSubject(item.type)) {
    throw new ArtifactError(`${where}type must be org, guild, or agent`, 422);
  }
  const id = typeof item.id === "string" ? item.id.trim() : "";
  if (!id) {
    throw new ArtifactError(`${where}id is required`, 422);
  }
  const mode = item.mode;
  if (!isAgentAccessMode(mode) || (item.type !== "agent" && !isAccessMode(mode))) {
    const modes = item.type === "agent" ? "none, read, or write" : "read or write";
    throw new ArtifactError(`${where}mode must be ${modes}`, 422);
  }
  return { type: item.type, id, mode };
}

/** The error prefix naming the grant at `index` of the list the operator sends. */
export function subjectAt(index: number): string {
  return `subjects[${index}]: `;
}

/** An item's access list as the operator sends it: the full list, one entry per subject. */
export const AccessListSchema = Type.Object({
  subjects: Type.Array(Type.Object({ type: Type.String(), id: Type.String(), mode: Type.String() })),
});

/** One subject of an access list as the operator sends it, before its type and mode are checked. */
export type SubjectEntry = Static<typeof AccessListSchema>["subjects"][number];

/** The full list the operator sends, one row per subject. */
export function parseGrants(value: SubjectEntry[]): AccessGrant[] {
  const grants = value.map((item, index) => parseGrant(item, subjectAt(index)));
  const seen = new Set<string>();
  grants.forEach((grant, index) => {
    if (seen.has(grantKey(grant))) {
      throw new ArtifactError(`${subjectAt(index)}the subject appears more than once`, 422);
    }
    seen.add(grantKey(grant));
  });
  return grants;
}

export function grantKey(grant: AccessSubjectRef): string {
  return `${grant.type}:${grant.id}`;
}

/** The rows to write and the subjects to drop to go from `before` to `after`. */
export function diffGrants(
  before: AccessGrant[],
  after: AccessGrant[],
): { upserts: AccessGrant[]; removals: AccessGrant[] } {
  const old = new Map(before.map((grant) => [grantKey(grant), grant.mode]));
  const wanted = new Set(after.map(grantKey));
  return {
    upserts: after.filter((grant) => old.get(grantKey(grant)) !== grant.mode),
    removals: before.filter((grant) => !wanted.has(grantKey(grant))),
  };
}

const MODE_WORDS: Record<AgentAccessMode, string> = { none: "no access", read: "read", write: "read and write" };

/** The change-log line for one subject's row going to `mode`, or removed when null. */
export function grantSummary(subject: string, item: string, mode: AgentAccessMode | null): string {
  if (mode === null) {
    return `Removed ${subject} from the access of ${item}`;
  }
  return `Gave ${subject} ${MODE_WORDS[mode]} on ${item}`;
}

/** Who an access list is read for: a guild, or one agent of that guild. */
export type AccessReader = { guildId: string; agentId: string | null };

/**
 * The mode an item's access list gives `reader`: an agent's own row when it has one, `none`
 * meaning no access; otherwise the better of its guild's row and the organisation's, `write`
 * implying `read`. Null when no row reaches it.
 */
export function effectiveAccess(entries: AccessGrant[], reader: AccessReader): AccessMode | null {
  const own =
    reader.agentId === null
      ? undefined
      : entries.find((entry) => entry.type === "agent" && entry.id === reader.agentId);
  if (own) {
    return isAccessMode(own.mode) ? own.mode : null;
  }
  const guild = entries.find(
    (entry) => entry.type === "guild" && entry.id === reader.guildId,
  )?.mode;
  const org = entries.find((entry) => entry.type === "org")?.mode;
  if (guild === "write" || org === "write") {
    return "write";
  }
  return isAccessMode(guild) || isAccessMode(org) ? "read" : null;
}

/** What an item's access list is raised to: a guild to at least `mode` when one is named, and each of `writerIds`, agents of that guild, to write. */
export type AccessRaise = { guildId: string; mode: AccessMode | null; writerIds: string[] };

/**
 * The rows that bring the guild up to `raise.mode` and each writer up to write, guild first. A
 * subject that already holds as much, its guild's row once raised included, gets no row, so a row
 * is never lowered.
 */
export function accessRaises(entries: AccessGrant[], raise: AccessRaise): AccessGrant[] {
  const held = effectiveAccess(entries, { guildId: raise.guildId, agentId: null });
  const wanted = raise.mode;
  const raisesGuild = wanted !== null && (wanted === "write" ? held !== "write" : held === null);
  const guildRows: AccessGrant[] = raisesGuild
    ? [{ type: "guild", id: raise.guildId, mode: wanted }]
    : [];
  const raised = [...guildRows, ...entries];
  const writers: AccessGrant[] = raise.writerIds
    .filter((agentId) => effectiveAccess(raised, { guildId: raise.guildId, agentId }) !== "write")
    .map((agentId) => ({ type: "agent", id: agentId, mode: "write" }));
  return [...guildRows, ...writers];
}
