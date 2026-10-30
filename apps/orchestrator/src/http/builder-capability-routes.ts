import { Type } from "@sinclair/typebox";
import { CapabilityService } from "../capabilities/index.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { HttpError } from "./errors.js";
import { currentOrg, currentUser } from "./identity.js";

/** A capability search: the text to look for, everything when left out. */
const CapabilitySearchQuery = Type.Object({ q: Type.Optional(Type.String()) });

/** The path of one connector, by its reference. */
const ServerRefParams = Type.Object({ server_ref: Type.String() });

export async function registerBuilderCapabilityRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const capabilities = deps.capabilities ?? new CapabilityService(deps.db, deps.policy);

  app.get("/api/builder/capabilities", async (request) => {
    const user = await currentUser(deps.db, request, deps);
    const org = await currentOrg(deps.db, request, user);
    return capabilities.listCapabilities({ orgId: String(org.id) });
  });

  app.get(
    "/api/builder/capabilities/search",
    { schema: { querystring: CapabilitySearchQuery } },
    async (request) => {
      const user = await currentUser(deps.db, request, deps);
      const org = await currentOrg(deps.db, request, user);
      return capabilities.searchCapabilities({ orgId: String(org.id) }, request.query.q ?? "");
    },
  );

  app.get(
    "/api/builder/servers/:server_ref",
    { schema: { params: ServerRefParams } },
    async (request) => {
      const user = await currentUser(deps.db, request, deps);
      const org = await currentOrg(deps.db, request, user);
      const record = await capabilities.describeServer(
        { orgId: String(org.id) },
        decodeURIComponent(request.params.server_ref),
      );
      if (!record) {
        throw new HttpError(404, "connector not found");
      }
      return record;
    },
  );
}
