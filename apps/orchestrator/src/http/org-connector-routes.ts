import type { FastifyInstance, FastifyRequest } from "fastify";
import { serverItem } from "../credentials/items.js";
import { isUniqueViolation } from "../db/pg.js";
import { CatalogError, createConnector, patchConnector } from "../mcp/catalog.js";
import { canManageSettings } from "../organisations/index.js";
import { LimitError, OPEN_POLICY } from "../policy/index.js";
import type { AppDeps } from "./deps.js";
import { HttpError } from "./errors.js";
import { currentUser } from "./identity.js";

function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function param(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, string>)[name];
  if (typeof value !== "string") {
    throw new HttpError(404, "Not Found");
  }
  return value;
}

function catalogHttp(error: unknown): never {
  if (isUniqueViolation(error)) {
    throw new HttpError(409, "slug or tool prefix already exists");
  }
  if (error instanceof CatalogError) {
    throw new HttpError(error.status, error.message);
  }
  throw error;
}

/**
 * An organisation's own remote MCP servers: owners and admins add one with a URL on public
 * HTTPS, a display name, and auth `none`, `token`, or OAuth with a dynamically registered
 * client. A server is visible to its organisation alone; another organisation's id is a 404.
 */
export async function registerOrgConnectorRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { repo } = deps;

  async function requireManager(request: FastifyRequest): Promise<string> {
    const orgId = param(request, "org_id");
    const user = await currentUser(repo, request, deps);
    const membership = await repo.getMembership(orgId, String(user.id));
    if (membership === null || !canManageSettings(String(membership.role))) {
      throw new HttpError(404, "organisation not found");
    }
    return orgId;
  }

  async function requireOwnServer(request: FastifyRequest, orgId: string): Promise<Record<string, unknown>> {
    const server = await repo.getMcpServer(param(request, "server_id"));
    if (server === null || server.owner_org_id !== orgId) {
      throw new HttpError(404, "mcp server not found");
    }
    return server;
  }

  app.get("/api/orgs/:org_id/mcp/servers", async (request) => {
    const orgId = await requireManager(request);
    const servers = (await repo.listMcpServers(orgId)).filter((server) => server.owner_org_id === orgId);
    return { servers: servers.map((server) => serverItem(server)) };
  });

  app.post("/api/orgs/:org_id/mcp/servers", async (request, reply) => {
    const orgId = await requireManager(request);
    const { limits } = await (deps.policy ?? OPEN_POLICY).standing(orgId);
    if (limits.maxMcpServers !== null && (await repo.countOrgConnectors(orgId)) >= limits.maxMcpServers) {
      const refused = new LimitError(limits.source, "MCP servers");
      throw new HttpError(refused.status, refused.message);
    }
    try {
      const row = await createConnector(repo, bodyOf(request), new Date(), orgId);
      reply.code(201);
      return serverItem(row);
    } catch (error) {
      catalogHttp(error);
    }
  });

  app.patch("/api/orgs/:org_id/mcp/servers/:server_id", async (request) => {
    const orgId = await requireManager(request);
    const server = await requireOwnServer(request, orgId);
    try {
      return serverItem(await patchConnector(repo, server, bodyOf(request)));
    } catch (error) {
      catalogHttp(error);
    }
  });

  app.delete("/api/orgs/:org_id/mcp/servers/:server_id", async (request, reply) => {
    const orgId = await requireManager(request);
    const server = await requireOwnServer(request, orgId);
    await repo.deleteConnector(String(server.id));
    return reply.code(204).send();
  });
}
