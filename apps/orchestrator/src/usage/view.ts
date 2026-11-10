import type { AgentRow } from "../db/agents.js";
import { listAgents, listAllAgents } from "../db/agents.js";
import { listGuilds, type GuildRow } from "../db/guilds.js";
import type { Queryable } from "../db/pg.js";
import { listOrgs, type OrgRow } from "../db/orgs.js";
import { getUsage, listUsageCounters } from "../db/usage.js";
import { canSeeGuild } from "../guilds/operators.js";
import { studioUsageByOrg } from "../studio/session.js";
import {
  orgUsage,
  usageCounterKey,
  usageFields,
  usageTree,
  type AgentUsage,
  type GuildUsage,
  type OrgUsage,
  type PlatformUsage,
  type RecordedUsage,
  type UsageRows,
  type UsageSource,
} from "./index.js";

/** A coach whose conversations spend tokens, by organisation. */
type CoachUsage = { usageByOrg(): Promise<UsageRows> };

/** What usage is read through: the database, and the Builder coach a box runs. */
export type UsageServices = {
  db: Queryable;
  builder?: CoachUsage | undefined;
};

/** The usage the box has recorded: its counters, and what Studio sessions and the Builder coach spent per organisation. */
async function recordedUsage(services: UsageServices): Promise<RecordedUsage> {
  const counters = new Map<string, UsageSource>();
  for (const row of await listUsageCounters(services.db)) {
    counters.set(usageCounterKey(row.scope, row.scope_id), row);
  }
  return {
    counters,
    studioByOrg: await studioUsageByOrg(services.db),
    builderByOrg: services.builder ? await services.builder.usageByOrg() : new Map(),
  };
}

/** One organisation's usage by guild and agent, limited to the guilds `userId` may see; every guild when null. */
export async function usageForOrg(
  services: UsageServices,
  org: Pick<OrgRow, "id" | "name" | "slug">,
  userId: string | null,
): Promise<OrgUsage> {
  const guilds = (await listGuilds(services.db)).filter(
    (guild) => guild.org_id === org.id && (userId === null || canSeeGuild(guild, userId)),
  );
  const guildIds = new Set(guilds.map((guild) => guild.id));
  const agents = (await listAllAgents(services.db)).filter((agent) => guildIds.has(agent.guild_id));
  return orgUsage(org, guilds, agents, await recordedUsage(services));
}

/** Every organisation's usage plus the server total, for the instance admin. */
export async function usageForPlatform(services: UsageServices): Promise<PlatformUsage> {
  const { db } = services;
  const [orgs, guilds, agents] = await Promise.all([
    listOrgs(db),
    listGuilds(db),
    listAllAgents(db),
  ]);
  return usageTree({ orgs, guilds, agents, ...(await recordedUsage(services)) });
}

/** A guild's usage, and each of its agents'. */
export async function usageForGuild(db: Queryable, guild: GuildRow): Promise<GuildUsage> {
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

/** An agent's usage, with its workspace's size and its machine's. */
export async function usageForAgent(db: Queryable, agent: AgentRow): Promise<AgentUsage> {
  return {
    id: agent.id,
    name: agent.name,
    guild_id: agent.guild_id,
    guild_name: agent.guild_name,
    workspace_mib: agent.workspace_mib,
    max_workspace_mib: agent.config.max_workspace_mib,
    machine: {
      id: agent.machine_id,
      name: agent.machine_name,
      workspace_mib: agent.machine_workspace_mib,
      max_workspace_mib: agent.machine_max_workspace_mib,
    },
    ...usageFields(await getUsage(db, "agent", agent.id)),
  };
}
