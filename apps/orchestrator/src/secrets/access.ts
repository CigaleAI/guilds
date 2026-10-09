import { formatColumnTimestamp } from "../db/codecs.js";
import { jsonObj } from "../db/json.js";

/** Who gets a secret: every agent of the organisation, or the granted guilds and agents. */
export type SecretAccess = {
  org_wide: boolean;
  guild_ids: string[];
  agent_ids: string[];
};

/** One grant row as the repository reads it: its target, that target's name, and the guild it sits in. */
export type SecretGrantRow = {
  guild_id: string | null;
  agent_id: string | null;
  name: string;
  in_guild_id: string;
};

/** Who is looking at a secret: their organisation role and the guilds they can see. */
export type SecretViewer = {
  role: string;
  visibleGuildIds: ReadonlySet<string>;
};

export class SecretAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretAccessError";
  }
}

/** Org owners and admins write every secret and are the only ones who change who gets one. */
export function managesOrgSecrets(role: string): boolean {
  return role === "owner" || role === "admin";
}

function idList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new SecretAccessError(`${field} must be a list of ids`);
  }
  return [...new Set((value as string[]).map((item) => item.trim()))];
}

/** Access from a request body. Organisation-wide clears the grants. */
export function validateSecretAccess(body: Record<string, unknown>): SecretAccess {
  const raw = body.org_wide;
  if (raw !== undefined && raw !== null && typeof raw !== "boolean") {
    throw new SecretAccessError("org_wide must be a boolean");
  }
  const guildIds = idList(body.guild_ids, "guild_ids");
  const agentIds = idList(body.agent_ids, "agent_ids");
  if (raw === true) {
    return { org_wide: true, guild_ids: [], agent_ids: [] };
  }
  return { org_wide: false, guild_ids: guildIds, agent_ids: agentIds };
}

export function secretGrants(row: Record<string, unknown>): SecretGrantRow[] {
  const loaded = jsonObj(row.grants ?? []);
  if (!Array.isArray(loaded)) {
    return [];
  }
  return loaded.map((item) => {
    const grant = item as Record<string, unknown>;
    return {
      guild_id: grant.guild_id === null || grant.guild_id === undefined ? null : String(grant.guild_id),
      agent_id: grant.agent_id === null || grant.agent_id === undefined ? null : String(grant.agent_id),
      name: String(grant.name ?? ""),
      in_guild_id: String(grant.in_guild_id ?? ""),
    };
  });
}

export function accessOf(row: Record<string, unknown>): SecretAccess {
  const grants = secretGrants(row);
  return {
    org_wide: Boolean(row.org_wide),
    guild_ids: grants.flatMap((grant) => (grant.guild_id ? [grant.guild_id] : [])),
    agent_ids: grants.flatMap((grant) => (grant.agent_id ? [grant.agent_id] : [])),
  };
}

/**
 * A secret is local to a member when it is not organisation-wide, has at least one
 * grant, and every grant targets a guild they can see or an agent in one.
 */
export function localTo(row: Record<string, unknown>, visibleGuildIds: ReadonlySet<string>): boolean {
  const grants = secretGrants(row);
  return (
    !row.org_wide &&
    grants.length > 0 &&
    grants.every((grant) => visibleGuildIds.has(grant.in_guild_id))
  );
}

/** The caller may edit, rotate, and delete this secret. */
export function canManageSecret(row: Record<string, unknown>, viewer: SecretViewer): boolean {
  return managesOrgSecrets(viewer.role) || localTo(row, viewer.visibleGuildIds);
}

/**
 * The caller may create a secret with this access: owners and admins any access,
 * a member grants only to guilds they can see and agents in them.
 */
export function canCreateSecret(
  access: SecretAccess,
  viewer: SecretViewer,
  agentGuilds: ReadonlyMap<string, string>,
): boolean {
  if (managesOrgSecrets(viewer.role)) {
    return true;
  }
  if (access.org_wide || (!access.guild_ids.length && !access.agent_ids.length)) {
    return false;
  }
  return (
    access.guild_ids.every((id) => viewer.visibleGuildIds.has(id)) &&
    access.agent_ids.every((id) => viewer.visibleGuildIds.has(agentGuilds.get(id) ?? ""))
  );
}

function iso(value: unknown): unknown {
  return typeof value === "string" ? formatColumnTimestamp(value) : value;
}

/**
 * A secret's metadata for one caller; never its value. A grant or creating agent
 * in a guild the caller cannot see keeps its kind and loses its id and name.
 */
export function secretMetadata(row: Record<string, unknown>, viewer: SecretViewer): Record<string, unknown> {
  const grants = secretGrants(row).map((grant) => {
    const visible = viewer.visibleGuildIds.has(grant.in_guild_id);
    return {
      kind: grant.guild_id ? "guild" : "agent",
      id: visible ? (grant.guild_id ?? grant.agent_id) : null,
      name: visible ? grant.name : null,
    };
  });
  let createdBy: Record<string, unknown> | null = null;
  if (row.created_by_user_id) {
    createdBy = {
      kind: "user",
      id: row.created_by_user_id,
      name: row.created_by_user_name ?? "",
    };
  } else if (row.created_by_agent_id) {
    const visible = viewer.visibleGuildIds.has(String(row.created_by_agent_guild_id ?? ""));
    createdBy = {
      kind: "agent",
      id: visible ? row.created_by_agent_id : null,
      name: visible ? (row.created_by_agent_name ?? "") : null,
    };
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    org_wide: Boolean(row.org_wide),
    grants,
    created_by: createdBy,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    rotated_at: iso(row.rotated_at),
    can_manage: canManageSecret(row, viewer),
  };
}
