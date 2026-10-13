import type { FastifyInstance, FastifyRequest } from "fastify";
import { CapabilityService } from "../capabilities/index.js";
import type { AppDeps } from "./deps.js";
import { HttpError } from "./errors.js";
import { currentOrg, currentUser } from "./identity.js";
import { param } from "./request.js";

function queryString(request: FastifyRequest, name: string): string {
  const value = (request.query as Record<string, unknown>)[name];
  return typeof value === "string" ? value : "";
}

export async function registerBuilderCapabilityRoutes(
  app: FastifyInstance,
  deps: AppDeps,
): Promise<void> {
  const capabilities = deps.capabilities ?? new CapabilityService(deps.repo, deps.policy);

  app.get("/api/builder/capabilities", async (request) => {
    const user = await currentUser(deps.repo, request, deps);
    const org = await currentOrg(deps.repo, request, user);
    return capabilities.listCapabilities({ orgId: String(org.id) });
  });

  app.get("/api/builder/capabilities/search", async (request) => {
    const user = await currentUser(deps.repo, request, deps);
    const org = await currentOrg(deps.repo, request, user);
    return capabilities.searchCapabilities({ orgId: String(org.id) }, queryString(request, "q"));
  });

  app.get("/api/builder/servers/:server_ref", async (request) => {
    const user = await currentUser(deps.repo, request, deps);
    const org = await currentOrg(deps.repo, request, user);
    const record = await capabilities.describeServer(
      { orgId: String(org.id) },
      decodeURIComponent(param(request, "server_ref")),
    );
    if (!record) {
      throw new HttpError(404, "connector not found");
    }
    return record;
  });
}
