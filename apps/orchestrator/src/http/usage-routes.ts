import type { FastifyInstance } from "fastify";
import { requireVisibleAgent } from "../agents/access.js";
import { requireVisibleGuild } from "../guilds/access.js";
import { usageForAgent, usageForGuild, usageForOrg, type UsageServices } from "../usage/view.js";
import type { AppDeps } from "./deps.js";
import { currentOrg, currentUser } from "./identity.js";
import { identityDatabase } from "../users/identity.js";
import { param } from "./request.js";

/** What the request's organisation, a guild and an agent spent. */
export async function registerUsageRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const identityDb = identityDatabase(db);
  const services: UsageServices = {
    db,
    studio: deps.studio ?? null,
    builder: deps.builder ?? null,
  };

  app.get("/api/usage", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    return { organisation: await usageForOrg(services, org, String(user.id)) };
  });

  app.get("/api/guilds/:guild_id/usage", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    return usageForGuild(
      db,
      await requireVisibleGuild(db, param(request, "guild_id"), String(user.id)),
    );
  });

  app.get("/api/agents/:agent_id/usage", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    return usageForAgent(
      db,
      await requireVisibleAgent(db, param(request, "agent_id"), String(user.id)),
    );
  });
}
