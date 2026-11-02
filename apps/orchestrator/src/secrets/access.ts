import { Type, type Static } from "typebox";
import type { SecretGrantRow, SecretRow } from "../db/secrets.js";
import { iso } from "../db/views.js";

/** Who gets a secret: every agent of the organisation, or the granted guilds and agents. */
export type SecretAccess = {
  org_wide: boolean;
  guild_ids: string[];
  agent_ids: string[];
};

/** Who gets a secret as a request names it: organisation-wide, or the guilds and agents granted. */
export const SecretAccessSchema = Type.Object({
  org_wide: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  guild_ids: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
  agent_ids: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
});

/** Who gets a secret, as a request names it, before its ids are checked; null is none. */
export type SecretAccessRequest = Static<typeof SecretAccessSchema>;

/** A change to who gets a secret, which names `org_wide`. */
export const SecretAccessChangeSchema = Type.Evaluate(
  Type.Intersect([
    Type.Omit(SecretAccessSchema, ["org_wide"]),
    Type.Object({ org_wide: Type.Union([Type.Boolean(), Type.Null()]) }),
  ]),
);

/**
 * One guild or agent a secret is granted to, as a viewer sees it. A grant in a guild the viewer
 * cannot see keeps its kind and shows no id or name.
 */
export type SecretGrant = { kind: "guild" | "agent"; id: string | null; name: string | null };

/** The operator who added a secret, or the agent that stored it; one in a guild the viewer cannot see shows no id or name. */
export type SecretCreator = { kind: "user" | "agent"; id: string | null; name: string | null };

/** A secret's metadata as one viewer sees it, with whether they may manage it; never its value. */
export type Secret = {
  id: SecretRow["id"];
  name: SecretRow["name"];
  description: SecretRow["description"];
  org_wide: SecretRow["org_wide"];
  grants: SecretGrant[];
  created_by: SecretCreator | null;
  created_at: string;
  updated_at: string;
  rotated_at: string;
  can_manage: boolean;
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

function idList(value: string[] | null | undefined, field: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (value.some((item) => !item.trim())) {
    throw new SecretAccessError(`${field} must be a list of ids`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

/** Access from a request body. Organisation-wide clears the grants. */
export function validateSecretAccess(body: SecretAccessRequest): SecretAccess {
  const guildIds = idList(body.guild_ids, "guild_ids");
  const agentIds = idList(body.agent_ids, "agent_ids");
  if (body.org_wide === true) {
    return { org_wide: true, guild_ids: [], agent_ids: [] };
  }
  return { org_wide: false, guild_ids: guildIds, agent_ids: agentIds };
}

/** Who gets a stored secret, read from its row and its grants. */
export function accessOf(row: SecretRow): SecretAccess {
  return {
    org_wide: row.org_wide,
    guild_ids: row.grants.flatMap((grant) => (grant.guild_id ? [grant.guild_id] : [])),
    agent_ids: row.grants.flatMap((grant) => (grant.agent_id ? [grant.agent_id] : [])),
  };
}

/** Whether a grant sits in a guild the viewer can see; one whose target is deleted sits in none. */
export function grantSeen(grant: SecretGrantRow, visibleGuildIds: ReadonlySet<string>): boolean {
  return grant.in_guild_id !== null && visibleGuildIds.has(grant.in_guild_id);
}

/**
 * A secret is local to a member when it is not organisation-wide, has at least one
 * grant, and every grant targets a guild they can see or an agent in one.
 */
export function localTo(row: SecretRow, visibleGuildIds: ReadonlySet<string>): boolean {
  return !row.org_wide && row.grants.length > 0 && row.grants.every((grant) => grantSeen(grant, visibleGuildIds));
}

/** The caller may edit, rotate, and delete this secret. */
export function canManageSecret(row: SecretRow, viewer: SecretViewer): boolean {
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

/** What created a secret, as one viewer sees it: the operator, or the agent when it sits in a guild they see. */
function secretCreator(row: SecretRow, viewer: SecretViewer): SecretCreator | null {
  if (row.created_by_user_id) {
    return { kind: "user", id: row.created_by_user_id, name: row.created_by_user_name ?? "" };
  }
  if (row.created_by_agent_id) {
    const visible = row.created_by_agent_guild_id !== null && viewer.visibleGuildIds.has(row.created_by_agent_guild_id);
    return {
      kind: "agent",
      id: visible ? row.created_by_agent_id : null,
      name: visible ? (row.created_by_agent_name ?? "") : null,
    };
  }
  return null;
}

/**
 * A secret's metadata for one caller; never its value. A grant or creating agent
 * in a guild the caller cannot see keeps its kind and loses its id and name.
 */
export function secretMetadata(row: SecretRow, viewer: SecretViewer): Secret {
  const grants = row.grants.map((grant): SecretGrant => {
    const visible = grantSeen(grant, viewer.visibleGuildIds);
    return {
      kind: grant.guild_id ? "guild" : "agent",
      id: visible ? (grant.guild_id ?? grant.agent_id) : null,
      name: visible ? (grant.name ?? "") : null,
    };
  });
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    org_wide: row.org_wide,
    grants,
    created_by: secretCreator(row, viewer),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    rotated_at: iso(row.rotated_at),
    can_manage: canManageSecret(row, viewer),
  };
}
