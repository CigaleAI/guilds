import type { FastifyInstance } from "fastify";
import { catalogServerItem, exportManifest, patchConnectorTool } from "../mcp/catalog.js";
import {
  createPlatformServer,
  listPlatformServers,
  patchPlatformServer,
  requirePlatformServer,
} from "../mcp/servers.js";
import type { AppDeps } from "./deps.js";
import { requireInstanceAdmin } from "./instance-admin.js";
import { bodyOf, param } from "./request.js";

/** The platform's connector catalog, managed by the instance admin. */
export async function registerAdminMcpRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;

  app.get("/api/admin/mcp/servers", async (request) => {
    await requireInstanceAdmin(deps, request);
    return { servers: (await listPlatformServers(db)).map((server) => catalogServerItem(server)) };
  });

  app.post("/api/admin/mcp/servers", async (request, reply) => {
    await requireInstanceAdmin(deps, request);
    return reply.code(201).send(catalogServerItem(await createPlatformServer(db, bodyOf(request))));
  });

  app.get("/api/admin/mcp/servers/:server_id", async (request) => {
    await requireInstanceAdmin(deps, request);
    return catalogServerItem(await requirePlatformServer(db, param(request, "server_id")));
  });

  app.patch("/api/admin/mcp/servers/:server_id", async (request) => {
    await requireInstanceAdmin(deps, request);
    const server = await requirePlatformServer(db, param(request, "server_id"));
    return catalogServerItem(await patchPlatformServer(db, server, bodyOf(request)));
  });

  app.patch("/api/admin/mcp/servers/:server_id/tools/:name", async (request) => {
    await requireInstanceAdmin(deps, request);
    const server = await requirePlatformServer(db, param(request, "server_id"));
    return catalogServerItem(
      await patchConnectorTool(db, server, param(request, "name"), bodyOf(request)),
    );
  });

  app.get("/api/admin/mcp/servers/:server_id/export", async (request, reply) => {
    await requireInstanceAdmin(deps, request);
    const server = await requirePlatformServer(db, param(request, "server_id"));
    return reply
      .header("content-disposition", `attachment; filename="${server.slug}-connector.json"`)
      .send(exportManifest(server));
  });
}
