import { ArtifactError } from "./errors.js";
import {
  isAccessMode,
  isAccessSubject,
  isAgentAccessMode,
  type AccessGrant,
  type AccessSubject,
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
  const item = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  if (!isAccessSubject(item.type)) {
    throw new ArtifactError(`${where}type must be org, guild, or agent`, 422);
  }
  const id = typeof item.id === "string" ? item.id.trim() : "";
  if (!id) {
    throw new ArtifactError(`${where}id is required`, 422);
  }
  if (item.type === "agent" ? !isAgentAccessMode(item.mode) : !isAccessMode(item.mode)) {
    const modes = item.type === "agent" ? "none, read, or write" : "read or write";
    throw new ArtifactError(`${where}mode must be ${modes}`, 422);
  }
  return { type: item.type, id, mode: item.mode as AgentAccessMode };
}

/** The error prefix naming the grant at `index` of the list the operator sends. */
export function subjectAt(index: number): string {
  return `subjects[${index}]: `;
}

/** The full list the operator sends, one row per subject. */
export function parseGrants(value: unknown): AccessGrant[] {
  if (!Array.isArray(value)) {
    throw new ArtifactError("subjects must be a list", 422);
  }
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

export function grantKey(grant: { type: AccessSubject; id: string }): string {
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
