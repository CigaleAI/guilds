import { Type } from "@sinclair/typebox";
import type { FastifyRequest } from "fastify";
import { ConnectorDraftSchema, ConnectorPatchSchema } from "../mcp/catalog.js";
import { serverItem } from "../mcp/view.js";
import {
  createOrgServer,
  deleteOrgServer,
  listOrgOwnServers,
  patchOrgServer,
  requireOrgServer,
} from "../mcp/servers.js";
import { requireOrgManager } from "../organisations/service.js";
import { OPEN_POLICY } from "../policy/index.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { currentUser } from "./identity.js";
import { OrgParams } from "./params.js";

/** The path of one of an organisation's own connectors. */
const OrgServerParams = Type.Object({ org_id: Type.String(), server_id: Type.String() });

/**
 * An organisation's own remote MCP servers: owners and admins add one with a URL on public
 * HTTPS, a display name, and auth `none`, `token`, or OAuth with a dynamically registered
 * client. A server is visible to its organisation alone; another organisation's id is a 404.
 */
export async function registerOrgConnectorRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const policy = deps.policy ?? OPEN_POLICY;

  /** The organisation the route names, which the request's user manages. */
  async function managedOrgId(request: FastifyRequest, orgId: string): Promise<string> {
    const user = await currentUser(db, request, deps);
    return (await requireOrgManager(db, orgId, user.id)).id;
  }

  app.get("/api/orgs/:org_id/mcp/servers", { schema: { params: OrgParams } }, async (request) => {
    const servers = await listOrgOwnServers(db, await managedOrgId(request, request.params.org_id));
    return { servers: servers.map((server) => serverItem(server)) };
  });

  app.post(
    "/api/orgs/:org_id/mcp/servers",
    { schema: { params: OrgParams, body: ConnectorDraftSchema } },
    async (request, reply) => {
      const orgId = await managedOrgId(request, request.params.org_id);
      const row = await createOrgServer(db, policy, orgId, request.body);
      return reply.code(201).send(serverItem(row));
    },
  );

  app.patch(
    "/api/orgs/:org_id/mcp/servers/:server_id",
    { schema: { params: OrgServerParams, body: ConnectorPatchSchema } },
    async (request) => {
      const orgId = await managedOrgId(request, request.params.org_id);
      const server = await requireOrgServer(db, orgId, request.params.server_id);
      return serverItem(await patchOrgServer(db, server, request.body));
    },
  );

  app.delete(
    "/api/orgs/:org_id/mcp/servers/:server_id",
    { schema: { params: OrgServerParams } },
    async (request, reply) => {
      const orgId = await managedOrgId(request, request.params.org_id);
      const server = await requireOrgServer(db, orgId, request.params.server_id);
      await deleteOrgServer(db, server);
      return reply.code(204).send();
    },
  );
}
