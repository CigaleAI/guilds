import type { AgentRow } from "../db/agents.js";
import { listAgents, listAllAgents } from "../db/agents.js";
import { listGuilds, type GuildRow } from "../db/guilds.js";
import type { Queryable } from "../db/pg.js";
import { listOrgs, type OrgRow } from "../db/orgs.js";
import { getUsage, listUsageCounters } from "../db/usage.js";
import { maxWorkspaceMibOf } from "../agents/validation.js";
import { canSeeGuild } from "../guilds/validation.js";
import { usageCounterKey, usageFields, usageTree, type UsageSource } from "./index.js";

/** A coach whose conversations spend tokens, by organisation. */
type CoachUsage = { usageByOrg(): Promise<Map<string, UsageSource>> };

/** What usage is read through: the database, and the Studio and Builder coaches a box runs. */
export type UsageServices = {
  db: Queryable;
  studio?: CoachUsage | undefined;
  builder?: CoachUsage | undefined;
};

async function counters(db: Queryable): Promise<Map<string, UsageSource>> {
  const map = new Map<string, UsageSource>();
  for (const row of await listUsageCounters(db)) {
    map.set(usageCounterKey(String(row.scope), String(row.scope_id ?? "")), row);
  }
  return map;
}

/** What the Studio and Builder coaches spent, per organisation. */
async function coachUsage(services: UsageServices) {
  return {
    studioByOrg: services.studio ? await services.studio.usageByOrg() : new Map(),
    builderByOrg: services.builder ? await services.builder.usageByOrg() : new Map(),
  };
}

/** One organisation's usage by guild and agent, limited to the guilds `userId` may see; every guild when null. */
export async function usageForOrg(
  services: UsageServices,
  org: Pick<OrgRow, "id" | "name" | "slug">,
  userId: string | null,
): Promise<Record<string, unknown>> {
  const orgId = org.id;
  const guilds = (await listGuilds(services.db)).filter(
    (guild) => guild.org_id === orgId && (userId === null || canSeeGuild(guild, userId)),
  );
  const guildIds = new Set(guilds.map((guild) => guild.id));
  const agents = (await listAllAgents(services.db)).filter((agent) => guildIds.has(agent.guild_id));
  const tree = usageTree({
    orgs: [org],
    guilds,
    agents,
    counters: await counters(services.db),
    ...(await coachUsage(services)),
  });
  const organisations = tree.organisations;
  const first: unknown = Array.isArray(organisations) ? organisations[0] : undefined;
  return first && typeof first === "object" ? { ...first } : { id: orgId };
}

/** Every organisation's usage plus the server total, for the instance admin. */
export async function usageForPlatform(services: UsageServices): Promise<Record<string, unknown>> {
  const { db } = services;
  const [orgs, guilds, agents] = await Promise.all([
    listOrgs(db),
    listGuilds(db),
    listAllAgents(db),
  ]);
  return usageTree({
    orgs,
    guilds,
    agents,
    counters: await counters(db),
    ...(await coachUsage(services)),
  });
}

/** A guild's usage, and each of its agents'. */
export async function usageForGuild(
  db: Queryable,
  guild: GuildRow,
): Promise<Record<string, unknown>> {
  const agents = await listAgents(db, guild.id);
  return {
    id: guild.id,
    name: guild.name,
    ...usageFields(await getUsage(db, "guild", guild.id)),
    agents: await Promise.all(
      agents.map(async (agent) => ({
        id: agent.id,
        name: agent.name,
        avatar_shape: agent.avatar_shape || "teardrop",
        avatar_color: agent.avatar_color || "#7c5cff",
        ...usageFields(await getUsage(db, "agent", agent.id)),
      })),
    ),
  };
}

function mibOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** An agent's usage, with its workspace's size and its machine's. */
export async function usageForAgent(
  db: Queryable,
  agent: AgentRow,
): Promise<Record<string, unknown>> {
  return {
    id: agent.id,
    name: agent.name,
    guild_id: agent.guild_id,
    guild_name: agent.guild_name,
    workspace_mib: mibOrNull(agent.workspace_mib),
    max_workspace_mib: maxWorkspaceMibOf(agent.config),
    machine: {
      id: agent.machine_id,
      name: agent.machine_name,
      workspace_mib: mibOrNull(agent.machine_workspace_mib),
      max_workspace_mib: Number(agent.machine_max_workspace_mib),
    },
    ...usageFields(await getUsage(db, "agent", agent.id)),
  };
}
