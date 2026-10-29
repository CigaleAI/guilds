// The artifact types, limits, and predicates (who acts, what an access list holds, how much a store
// keeps), imported directly by other domains.
import { ACCESS_MODES, type AccessMode } from "../db/schema/index.js";
import type { ChangeActor } from "../lib/change-actor.js";

export const ARTIFACT_LEVELS = ["agent", "guild", "org"] as const;
export type ArtifactLevel = (typeof ARTIFACT_LEVELS)[number];

export const ARTIFACT_KINDS = ["note", "object", "memory", "script", "file"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** The private guilds of the organisation an operator does not operate, with their agents. */
export type HiddenGuilds = { guildIds: readonly string[]; agentIds: readonly string[] };

export const NO_HIDDEN_GUILDS: HiddenGuilds = { guildIds: [], agentIds: [] };

/** Who reads or writes, and what they reach. Its change fields stamp every change it makes. */
export type ArtifactActor = ChangeActor & {
  orgId: string;
  guildId: string | null;
  agentId: string | null;
  operator: boolean;
  /** What an operator actor never reaches: the notes, Memory, and own tables of these guilds and agents. */
  hidden: HiddenGuilds;
};

/**
 * One row of an item's access list. An org or guild row gives every agent in
 * it a mode; an agent row replaces that for one agent and may lower it,
 * `none` meaning no access at all.
 */
export const AGENT_ACCESS_MODES = ["none", "read", "write"] as const;
export type AgentAccessMode = (typeof AGENT_ACCESS_MODES)[number];
export const ACCESS_SUBJECTS = ["org", "guild", "agent"] as const;
export type AccessSubject = (typeof ACCESS_SUBJECTS)[number];
/** What carries an access list: a note, a collection, or a file. */
export const ACCESS_TARGETS = ["note", "collection", "file"] as const;
export type AccessTargetKind = (typeof ACCESS_TARGETS)[number];
export type AccessTarget = { kind: AccessTargetKind; id: string };

/** One row of an item's access list as the operator reads and writes it. */
export type AccessEntry = {
  type: AccessSubject;
  id: string;
  name: string;
  mode: AgentAccessMode;
  /** The guild of a guild subject, or of an agent subject; null for the organisation. */
  guild_id: string | null;
  guild_name: string | null;
};

export type AccessGrant = { type: AccessSubject; id: string; mode: AgentAccessMode };

/**
 * An item's access list as the operator reads it. `owner_agent_id` is the
 * agent that owns an agent-level note: it always writes its own note, so the
 * list takes no row for it. Null for every other item.
 */
export type AccessList = { subjects: AccessEntry[]; owner_agent_id: string | null };

export const WRITE_MAX_BYTES = 256 * 1024;
/** The largest file one put may store. */
export const FILE_MAX_BYTES = 10 * 1024 * 1024;
/** The bytes an organisation's live files may hold together. */
export const ORG_FILE_BYTES_MAX = 1024 * 1024 * 1024;
export const FILE_DESCRIPTION_MAX = 400;
export const LIVE_ARTIFACTS_MAX = 10_000;
export const LIVE_RECORDS_MAX = 10_000;
export const LIVE_COLLECTIONS_MAX = 100;
export const FIND_DEFAULT = 20;
export const FIND_MAX = 100;
export const STATE_COLLECTIONS_MAX = 50;
export const EMBED_BUDGET = 64 * 1024;
export const SEARCH_TEXT_MAX = 400;
export const PURPOSE_MAX = 400;
export const MEMORY_REVISIONS_MAX = 50;
export const TASK_REVISIONS_MAX = 50;

export const COLLECTION_NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/;

export function isArtifactLevel(value: string): value is ArtifactLevel {
  return (ARTIFACT_LEVELS as readonly string[]).includes(value);
}

export function isArtifactKind(value: string): value is ArtifactKind {
  return (ARTIFACT_KINDS as readonly string[]).includes(value);
}

export function isAccessMode(value: unknown): value is AccessMode {
  return typeof value === "string" && (ACCESS_MODES as readonly string[]).includes(value);
}

export function isAgentAccessMode(value: unknown): value is AgentAccessMode {
  return typeof value === "string" && (AGENT_ACCESS_MODES as readonly string[]).includes(value);
}

export function isAccessSubject(value: unknown): value is AccessSubject {
  return typeof value === "string" && (ACCESS_SUBJECTS as readonly string[]).includes(value);
}
