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
import { currentUser } from "./identity.js";
import { isInstanceAdmin } from "./instance-admin.js";

function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

function param(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, string>)[name];
  if (typeof value !== "string") {
    throw new HttpError(404, "Not Found");
  }
  return value;
}

async function requireInstanceAdmin(deps: AppDeps, request: FastifyRequest) {
  const user = await currentUser(deps.repo, request, deps);
  if (!(await isInstanceAdmin(deps, String(user.id)))) {
    throw new HttpError(404, "Not Found");
  }
  return user;
}

function catalogHttp(error: unknown): never {
  if (error instanceof CatalogError) {
    throw new HttpError(error.status, error.message);
  }
  throw error;
}

export async function registerAdminMcpRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { repo } = deps;

  async function requireServer(request: FastifyRequest): Promise<Record<string, unknown>> {
    const server = await repo.getMcpServer(param(request, "server_id"));
    if (!server || server.owner_org_id) {
      throw new HttpError(404, "mcp server not found");
    }
    return server;
  }

  app.get("/api/admin/mcp/servers", async (request) => {
    await requireInstanceAdmin(deps, request);
    const servers = (await repo.listMcpServers()).filter((server) => !server.owner_org_id);
    return { servers: servers.map((server) => catalogServerItem(server)) };
  });

  app.post("/api/admin/mcp/servers", async (request, reply) => {
    await requireInstanceAdmin(deps, request);
    try {
      const row = await createConnector(repo, bodyOf(request));
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
      return catalogServerItem(await patchConnector(repo, server, bodyOf(request)));
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
      return catalogServerItem(await patchConnectorTool(repo, server, param(request, "name"), bodyOf(request)));
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
