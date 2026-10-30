import { requireVisibleAgent } from "../agents/access.js";
import { loadAccessView } from "../access/view.js";
import { requireVisibleGuild } from "../guilds/access.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { HttpError } from "./errors.js";
import { currentOrg, currentUser } from "./identity.js";
import { isInstanceAdmin } from "./instance-admin.js";
import { AgentParams, GuildParams } from "./params.js";

/** The access view at each level: the instance's, the organisation's, a guild's and an agent's. */
export async function registerAccessRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const mcp = deps.mcp ?? null;

  app.get("/api/platform", async (request) => {
    const user = await currentUser(db, request, deps);
    if (!(await isInstanceAdmin(deps, user.id))) {
      throw new HttpError(404, "Not Found");
    }
    return loadAccessView(db, { viewScope: "platform", mcp });
  });

  app.get("/api/access", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    return loadAccessView(db, { orgId: String(org.id), viewScope: "org", mcp });
  });

  app.get("/api/guilds/:guild_id/access", { schema: { params: GuildParams } }, async (request) => {
    const user = await currentUser(db, request, deps);
    const guild = await requireVisibleGuild(db, request.params.guild_id, user.id);
    return loadAccessView(db, {
      orgId: guild.org_id,
      guildId: guild.id,
      viewScope: "guild",
      mcp,
    });
  });

  app.get("/api/agents/:agent_id/access", { schema: { params: AgentParams } }, async (request) => {
    const user = await currentUser(db, request, deps);
    const agent = await requireVisibleAgent(db, request.params.agent_id, user.id);
    return loadAccessView(db, {
      orgId: agent.org_id,
      guildId: agent.guild_id,
      agentId: agent.id,
      viewScope: "agent",
      mcp,
    });
  });
}
