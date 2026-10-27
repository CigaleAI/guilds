import type { FastifyInstance, FastifyRequest } from "fastify";
import { isUniqueViolation } from "../db/pg.js";
import {
  CatalogError,
  catalogServerItem,
  createConnector,
  exportManifest,
  patchConnector,
  patchConnectorTool,
} from "../mcp/catalog.js";
import type { AppDeps } from "./deps.js";
import { HttpError } from "./errors.js";
import { refreshConnectorIntegrations } from "../instance/connectors.js";
import { requireInstanceAdmin } from "./instance-admin.js";
import { bodyOf, param } from "./request.js";
import { getMcpServer, listMcpServers } from "../db/connectors.js";

function catalogHttp(error: unknown): never {
  if (error instanceof CatalogError) {
    throw new HttpError(error.status, error.message);
  }
  throw error;
}

export async function registerAdminMcpRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;

  async function requireServer(request: FastifyRequest): Promise<Record<string, unknown>> {
    const server = await getMcpServer(db, param(request, "server_id"));
    if (!server || server.owner_org_id) {
      throw new HttpError(404, "mcp server not found");
    }
    return server;
  }

  app.get("/api/admin/mcp/servers", async (request) => {
    await requireInstanceAdmin(deps, request);
    const servers = (await listMcpServers(db)).filter((server) => !server.owner_org_id);
    return { servers: servers.map((server) => catalogServerItem(server)) };
  });

  app.post("/api/admin/mcp/servers", async (request, reply) => {
    await requireInstanceAdmin(deps, request);
    try {
      const row = await createConnector(db, bodyOf(request));
      await refreshConnectorIntegrations(db);
      reply.code(201);
      return catalogServerItem(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError(409, "slug or tool prefix already exists");
      }
      catalogHttp(error);
    }
  });

  app.get("/api/admin/mcp/servers/:server_id", async (request) => {
    await requireInstanceAdmin(deps, request);
    return catalogServerItem(await requireServer(request));
  });

  app.patch("/api/admin/mcp/servers/:server_id", async (request) => {
    await requireInstanceAdmin(deps, request);
    const server = await requireServer(request);
    try {
      const patched = await patchConnector(db, server, bodyOf(request));
      await refreshConnectorIntegrations(db);
      return catalogServerItem(patched);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError(409, "slug or tool prefix already exists");
      }
      catalogHttp(error);
    }
  });

  app.patch("/api/admin/mcp/servers/:server_id/tools/:name", async (request) => {
    await requireInstanceAdmin(deps, request);
    const server = await requireServer(request);
    try {
      return catalogServerItem(await patchConnectorTool(db, server, param(request, "name"), bodyOf(request)));
    } catch (error) {
      catalogHttp(error);
    }
  });

  app.get("/api/admin/mcp/servers/:server_id/export", async (request, reply) => {
    await requireInstanceAdmin(deps, request);
    const server = await requireServer(request);
    return reply
      .header("content-disposition", `attachment; filename="${String(server.slug)}-connector.json"`)
      .send(exportManifest(server));
  });
}
