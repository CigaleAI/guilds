import { canSeeGuild } from "../guilds/validation.js";
import { usageCounterKey, usageTree } from "../usage.js";
import type { AppDeps } from "./deps.js";

async function counters(deps: AppDeps): Promise<Map<string, unknown>> {
  const map = new Map<string, unknown>();
  for (const row of await deps.repo.listUsageCounters()) {
    map.set(usageCounterKey(String(row.scope), String(row.scope_id ?? "")), row);
  }
  return map;
}

/** What the Studio and Builder coaches spent, per organisation. */
async function coachUsage(deps: AppDeps): Promise<{ studioByOrg: Map<string, unknown>; builderByOrg: Map<string, unknown> }> {
  return {
    studioByOrg: deps.studio ? await deps.studio.store.studioUsageByOrg() : new Map(),
    builderByOrg: deps.builder ? await deps.builder.store.builderUsageByOrg() : new Map(),
  };
}

/** One organisation's usage by guild and agent, limited to the guilds `userId` may see. */
export async function usageForOrg(
  deps: AppDeps,
  org: Record<string, unknown>,
  userId: string | null,
): Promise<Record<string, unknown>> {
  const orgId = String(org.id);
  const guilds = (await deps.repo.listGuilds()).filter(
    (guild) =>
      String(guild.org_id) === orgId && (userId === null || canSeeGuild(guild, userId)),
  );
  const guildIds = new Set(guilds.map((guild) => String(guild.id)));
  const agents = (await deps.repo.listAllAgents()).filter((agent) =>
    guildIds.has(String(agent.guild_id)),
  );
  const tree = usageTree({ orgs: [org], guilds, agents, counters: await counters(deps), ...(await coachUsage(deps)) });
  return (tree.organisations as Array<Record<string, unknown>>)[0] ?? { id: orgId };
}

/** Every organisation's usage plus the server total, for platform admins. */
export async function usageForPlatform(deps: AppDeps): Promise<Record<string, unknown>> {
  const orgs = await deps.repo.listOrgs();
  const guilds = await deps.repo.listGuilds();
  const agents = await deps.repo.listAllAgents();
  return usageTree({ orgs, guilds, agents, counters: await counters(deps), ...(await coachUsage(deps)) });
}
