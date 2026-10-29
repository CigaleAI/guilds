import { requireVisibleAgent } from "../agents/access.js";
import { requireVisibleGuild } from "../guilds/access.js";
import { usageForAgent, usageForGuild, usageForOrg, type UsageServices } from "../usage/view.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { currentOrg, currentUser } from "./identity.js";
import { AgentParams, GuildParams } from "./params.js";

/** What the request's organisation, a guild and an agent spent. */
export async function registerUsageRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const services: UsageServices = deps;

  app.get("/api/usage", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    return { organisation: await usageForOrg(services, org, user.id) };
  });

  app.get("/api/guilds/:guild_id/usage", { schema: { params: GuildParams } }, async (request) => {
    const user = await currentUser(db, request, deps);
    return usageForGuild(db, await requireVisibleGuild(db, request.params.guild_id, user.id));
  });

  app.get("/api/agents/:agent_id/usage", { schema: { params: AgentParams } }, async (request) => {
    const user = await currentUser(db, request, deps);
    return usageForAgent(db, await requireVisibleAgent(db, request.params.agent_id, user.id));
  });
}
