import type { FastifyInstance } from "fastify";
import { installedIntegrations, integrationStatuses } from "../instance/integrations.js";
import type { AppDeps } from "./deps.js";
import { currentUser, identityDatabase } from "./identity.js";
import { isInstanceAdmin } from "./instance-admin.js";

/** What this box is, for whoever reaches it. */
export async function registerInstanceRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const identityDb = identityDatabase(deps.db);

  /**
   * How this box identifies a request and which integrations it has, never a key. An instance
   * admin also sees when and by whom each store integration was written.
   */
  app.get("/api/instance", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const audit = await isInstanceAdmin(deps, String(user.id));
    return {
      auth_mode: deps.config?.authMode ?? "compat-cookie",
      integrations: integrationStatuses(
        deps.integrations ?? installedIntegrations(),
        undefined,
        undefined,
        {
          audit,
        },
      ),
    };
  });
}
