import { Type } from "@sinclair/typebox";
import {
  catalogServerItem,
  ConnectorDraftSchema,
  ConnectorPatchSchema,
  exportManifest,
  patchConnectorTool,
  ToolEditSchema,
} from "../mcp/catalog.js";
import {
  createPlatformServer,
  listPlatformServers,
  patchPlatformServer,
  requirePlatformServer,
} from "../mcp/servers.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { instanceAdminOnly } from "./instance-admin.js";

/** The path of one platform connector. */
const ServerParams = Type.Object({ server_id: Type.String() });

/** The path of one tool of a platform connector. */
const ServerToolParams = Type.Object({ server_id: Type.String(), name: Type.String() });

/** The platform's connector catalog, managed by the instance admin. */
export async function registerAdminMcpRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const preValidation = instanceAdminOnly(deps);

  app.get("/api/admin/mcp/servers", { preValidation }, async () => ({
    servers: (await listPlatformServers(db)).map((server) => catalogServerItem(server)),
  }));

  app.post(
    "/api/admin/mcp/servers",
    { preValidation, schema: { body: ConnectorDraftSchema } },
    async (request, reply) =>
      reply.code(201).send(catalogServerItem(await createPlatformServer(db, request.body))),
  );

  app.get(
    "/api/admin/mcp/servers/:server_id",
    { preValidation, schema: { params: ServerParams } },
    async (request) =>
      catalogServerItem(await requirePlatformServer(db, request.params.server_id)),
  );

  app.patch(
    "/api/admin/mcp/servers/:server_id",
    { preValidation, schema: { params: ServerParams, body: ConnectorPatchSchema } },
    async (request) => {
      const server = await requirePlatformServer(db, request.params.server_id);
      return catalogServerItem(await patchPlatformServer(db, server, request.body));
    },
  );

  app.patch(
    "/api/admin/mcp/servers/:server_id/tools/:name",
    { preValidation, schema: { params: ServerToolParams, body: ToolEditSchema } },
    async (request) => {
      const server = await requirePlatformServer(db, request.params.server_id);
      return catalogServerItem(
        await patchConnectorTool(db, server, request.params.name, request.body),
      );
    },
  );

  app.get(
    "/api/admin/mcp/servers/:server_id/export",
    { preValidation, schema: { params: ServerParams } },
    async (request, reply) => {
      const server = await requirePlatformServer(db, request.params.server_id);
      return reply
        .header("content-disposition", `attachment; filename="${server.slug}-connector.json"`)
        .send(exportManifest(server));
    },
  );
}
