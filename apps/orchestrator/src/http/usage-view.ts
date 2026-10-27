import { canSeeGuild } from "../guilds/validation.js";
import { usageCounterKey, usageTree } from "../usage.js";
import type { AppDeps } from "./deps.js";
import { listUsageCounters } from "../db/usage.js";
import { listGuilds } from "../db/guilds.js";
import { listAllAgents } from "../db/agents.js";
import { listOrgs } from "../db/orgs.js";

async function counters(deps: AppDeps): Promise<Map<string, unknown>> {
  const map = new Map<string, unknown>();
  for (const row of await listUsageCounters(deps.db)) {
    map.set(usageCounterKey(String(row.scope), String(row.scope_id ?? "")), row);
  }
  return map;
}

/** What the Studio and Builder coaches spent, per organisation. */
async function coachUsage(deps: AppDeps): Promise<{ studioByOrg: Map<string, unknown>; builderByOrg: Map<string, unknown> }> {
  return {
    studioByOrg: deps.studio ? await deps.studio.usageByOrg() : new Map(),
    builderByOrg: deps.builder ? await deps.builder.usageByOrg() : new Map(),
  };
}

/** One organisation's usage by guild and agent, limited to the guilds `userId` may see. */
export async function usageForOrg(
  deps: AppDeps,
  org: Record<string, unknown>,
  userId: string | null,
): Promise<Record<string, unknown>> {
  const orgId = String(org.id);
  const guilds = (await listGuilds(deps.db)).filter(
    (guild) =>
      String(guild.org_id) === orgId && (userId === null || canSeeGuild(guild, userId)),
  );
  const guildIds = new Set(guilds.map((guild) => String(guild.id)));
  const agents = (await listAllAgents(deps.db)).filter((agent) =>
    guildIds.has(String(agent.guild_id)),
  );
  const tree = usageTree({ orgs: [org], guilds, agents, counters: await counters(deps), ...(await coachUsage(deps)) });
  return (tree.organisations as Array<Record<string, unknown>>)[0] ?? { id: orgId };
}

/** Every organisation's usage plus the server total, for platform admins. */
export async function usageForPlatform(deps: AppDeps): Promise<Record<string, unknown>> {
  const orgs = await listOrgs(deps.db);
  const guilds = await listGuilds(deps.db);
  const agents = await listAllAgents(deps.db);
  return usageTree({ orgs, guilds, agents, counters: await counters(deps), ...(await coachUsage(deps)) });
}
