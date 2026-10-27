import { requireVisibleAgent } from "../agents/access.js";
import { getAgent } from "../db/agents.js";
import { getGuild } from "../db/guilds.js";
import type { McpConnectionRow } from "../db/mcp.js";
import { getMembership } from "../db/orgs.js";
import type { Queryable } from "../db/pg.js";
import { requireVisibleGuild } from "../guilds/access.js";
import { canSeeGuild } from "../guilds/validation.js";

/** A request about a connector login refused, with the HTTP status it answers with. */
export class ConnectionError extends Error {
  status: number;
  detail: unknown;

  constructor(status: number, detail: string | Record<string, unknown>) {
    super(typeof detail === "string" ? detail : String(detail.message ?? ""));
    this.name = "ConnectionError";
    this.status = status;
    this.detail = detail;
  }
}

/** Whether an organisation sees a server: the platform's, or one of its own. */
export function serverVisible(server: Record<string, unknown>, orgId: string | null): boolean {
  return !server.owner_org_id || server.owner_org_id === orgId;
}

/** Whether the user sees a guild's agent: a member of its organisation who sees its guild. */
async function seesAgent(db: Queryable, agentId: string, userId: string): Promise<boolean> {
  const agent = await getAgent(db, agentId);
  if (agent === null || (await getMembership(db, agent.org_id, userId)) === null) {
    return false;
  }
  const guild = await getGuild(db, agent.guild_id);
  return guild !== null && canSeeGuild(guild, userId);
}

/** Whether the user sees a login: the platform's, or one owned where they are a member and see the guild. */
export async function seesConnection(
  db: Queryable,
  row: Pick<McpConnectionRow, "owner_scope" | "owner_id">,
  userId: string,
): Promise<boolean> {
  const ownerId = String(row.owner_id || "");
  if (row.owner_scope === "platform") {
    return true;
  }
  if (row.owner_scope === "org") {
    return (await getMembership(db, ownerId, userId)) !== null;
  }
  if (row.owner_scope === "guild") {
    const guild = await getGuild(db, ownerId);
    return (
      guild !== null &&
      canSeeGuild(guild, userId) &&
      (await getMembership(db, guild.org_id, userId)) !== null
    );
  }
  return seesAgent(db, ownerId, userId);
}

/** The organisation an owner belongs to; null for the platform or an owner that no longer exists. */
export async function ownerOrgId(
  db: Queryable,
  ownerScope: string,
  ownerId: string | null,
): Promise<string | null> {
  if (ownerScope === "org") {
    return ownerId;
  }
  if (ownerScope === "guild") {
    return (await getGuild(db, ownerId ?? ""))?.org_id ?? null;
  }
  if (ownerScope === "agent") {
    return (await getAgent(db, ownerId ?? ""))?.org_id ?? null;
  }
  return null;
}

/**
 * Refuses an owner the user may not act for: the platform, an organisation they are not in, or a
 * guild or agent they do not see. Answers the guild the owner sits in; null for an organisation.
 */
export async function assertActsFor(
  db: Queryable,
  ownerScope: string,
  ownerId: string | null,
  userId: string,
): Promise<string | null> {
  if (ownerScope === "platform") {
    throw new ConnectionError(400, "platform-owned credentials cannot be created here");
  }
  if (ownerScope === "org") {
    if ((await getMembership(db, ownerId || "", userId)) === null) {
      throw new ConnectionError(404, "organisation not found");
    }
    return null;
  }
  if (ownerScope === "guild") {
    return (await requireVisibleGuild(db, ownerId || "", userId)).id;
  }
  return (await requireVisibleAgent(db, ownerId || "", userId)).guild_id;
}
