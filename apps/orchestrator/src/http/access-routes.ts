import type { FastifyInstance } from "fastify";
import { requireVisibleAgent } from "../agents/access.js";
import { loadAccessView } from "../access/view.js";
import { requireVisibleGuild } from "../guilds/access.js";
import { mcpDatabase } from "../mcp/index.js";
import type { AppDeps } from "./deps.js";
import { HttpError } from "./errors.js";
import { currentOrg, currentUser } from "./identity.js";
import { identityDatabase } from "../users/identity.js";
import { isInstanceAdmin } from "./instance-admin.js";
import { param } from "./request.js";

/** The access view at each level: the instance's, the organisation's, a guild's and an agent's. */
export async function registerAccessRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const identityDb = identityDatabase(db);
  const mcp = deps.mcp ?? null;

  app.get("/api/platform", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    if (!(await isInstanceAdmin(deps, user.id))) {
      throw new HttpError(404, "Not Found");
    }
    return loadAccessView(mcpDatabase(db), { viewScope: "platform", mcp });
  });

  app.get("/api/access", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    return loadAccessView(mcpDatabase(db), { orgId: String(org.id), viewScope: "org", mcp });
  });

  app.get("/api/guilds/:guild_id/access", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), user.id);
    return loadAccessView(mcpDatabase(db), {
      orgId: guild.org_id,
      guildId: guild.id,
      viewScope: "guild",
      mcp,
    });
  });

  app.get("/api/agents/:agent_id/access", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const agent = await requireVisibleAgent(db, param(request, "agent_id"), user.id);
    return loadAccessView(mcpDatabase(db), {
      orgId: agent.org_id,
      guildId: agent.guild_id,
      agentId: agent.id,
      viewScope: "agent",
      mcp,
    });
  });
}
