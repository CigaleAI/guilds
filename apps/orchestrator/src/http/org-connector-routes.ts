import type { FastifyInstance, FastifyRequest } from "fastify";
import { serverItem } from "../credentials/items.js";
import {
  createOrgServer,
  deleteOrgServer,
  listOrgOwnServers,
  patchOrgServer,
  requireOrgServer,
} from "../mcp/servers.js";
import { requireOrgManager } from "../organisations/service.js";
import { OPEN_POLICY } from "../policy/index.js";
import type { AppDeps } from "./deps.js";
import { currentUser } from "./identity.js";
import { identityDatabase } from "../users/identity.js";
import { bodyOf, param } from "./request.js";

/**
 * An organisation's own remote MCP servers: owners and admins add one with a URL on public
 * HTTPS, a display name, and auth `none`, `token`, or OAuth with a dynamically registered
 * client. A server is visible to its organisation alone; another organisation's id is a 404.
 */
export async function registerOrgConnectorRoutes(
  app: FastifyInstance,
  deps: AppDeps,
): Promise<void> {
  const { db } = deps;
  const identityDb = identityDatabase(db);
  const policy = deps.policy ?? OPEN_POLICY;

  /** The organisation the route names, which the request's user manages. */
  async function managedOrgId(request: FastifyRequest): Promise<string> {
    const user = await currentUser(identityDb, request, deps);
    return (await requireOrgManager(db, param(request, "org_id"), user.id)).id;
  }

  app.get("/api/orgs/:org_id/mcp/servers", async (request) => {
    const servers = await listOrgOwnServers(db, await managedOrgId(request));
    return { servers: servers.map((server) => serverItem(server)) };
  });

  app.post("/api/orgs/:org_id/mcp/servers", async (request, reply) => {
    const row = await createOrgServer(db, policy, await managedOrgId(request), bodyOf(request));
    return reply.code(201).send(serverItem(row));
  });

  app.patch("/api/orgs/:org_id/mcp/servers/:server_id", async (request) => {
    const server = await requireOrgServer(
      db,
      await managedOrgId(request),
      param(request, "server_id"),
    );
    return serverItem(await patchOrgServer(db, server, bodyOf(request)));
  });

  app.delete("/api/orgs/:org_id/mcp/servers/:server_id", async (request, reply) => {
    const server = await requireOrgServer(
      db,
      await managedOrgId(request),
      param(request, "server_id"),
    );
    await deleteOrgServer(db, server);
    return reply.code(204).send();
  });
}
