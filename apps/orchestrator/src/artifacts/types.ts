export const ARTIFACT_LEVELS = ["agent", "guild", "org"] as const;
export type ArtifactLevel = (typeof ARTIFACT_LEVELS)[number];

export const ARTIFACT_KINDS = ["note", "object", "memory", "script"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const ARTIFACT_GRANT_IDS = ["read_guild", "read_org", "write_guild", "write_org"] as const;

/** The four note grants. Collections are not governed by them. */
export type ArtifactGrants = {
  readGuild: boolean;
  readOrg: boolean;
  writeGuild: boolean;
  writeOrg: boolean;
};

export const DEFAULT_ARTIFACT_GRANTS: ArtifactGrants = {
  readGuild: true,
  readOrg: true,
  writeGuild: true,
  writeOrg: false,
};

export const OPERATOR_GRANTS: ArtifactGrants = {
  readGuild: true,
  readOrg: true,
  writeGuild: true,
  writeOrg: true,
};

export type ArtifactActor = {
  orgId: string;
  guildId: string | null;
  agentId: string | null;
  operator: boolean;
  grants: ArtifactGrants;
  actorType: "user" | "agent" | "run";
  actorId: string;
  actorName: string;
  toolCall: { id: string; name: string } | null;
};

/**
 * A collection grant. A guild row is the base mode for its members; an agent
 * row overrides that base for one agent and may lower it, `none` meaning no
 * access at all.
 */
export const ACCESS_MODES = ["read", "write"] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];
export const AGENT_ACCESS_MODES = ["none", "read", "write"] as const;
export type AgentAccessMode = (typeof AGENT_ACCESS_MODES)[number];
export const ACCESS_SUBJECTS = ["guild", "agent"] as const;
export type AccessSubject = (typeof ACCESS_SUBJECTS)[number];

export const WRITE_MAX_BYTES = 256 * 1024;
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

/** `write` implies `read`; a missing grant is no access. */
/**
 * The mode an agent ends up with: its own row when it has one, `none` meaning
 * no access, otherwise the base its guild gives it.
 */
export function resolveAccess(base: AccessMode | null, override: AgentAccessMode | null): AccessMode | null {
  if (override === null || override === undefined) {
    return base;
  }
  return override === "none" ? null : override;
}
