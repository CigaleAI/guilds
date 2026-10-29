import type { FastifyInstance } from "fastify";
import {
  callConnectionTool,
  deleteConnection,
  listConnections,
  listOrgServers,
  lookupWithCredentials,
  lookupWithLogin,
  readConnectorLogo,
  requireVisibleConnection,
  saveConnectionSettings,
  viewConnection,
  type ConnectionServices,
} from "../mcp/connections.js";
import type { AppDeps } from "./deps.js";
import { currentOrg, currentUser } from "./identity.js";
import { bodyOf, param, queryOf } from "./request.js";

/** The connectors an organisation sees, and its members' logins to them: read, used, set up, and removed. */
export async function registerConnectionRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const services: ConnectionServices = { db, mcp: deps.mcp ?? null, masterKey: deps.masterKey };

  app.get("/api/mcp/servers", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    return listOrgServers(db, String(org.id));
  });

  app.get("/api/mcp/servers/:server_id/logo", async (request, reply) => {
    await currentUser(db, request, deps);
    const logo = await readConnectorLogo(param(request, "server_id"));
    return reply
      .code(200)
      .header("content-type", "image/svg+xml")
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "private, max-age=3600")
      .send(logo);
  });

  app.get("/api/mcp/connections", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    const query = queryOf(request);
    const scope = { guildId: query.guild_id || null, agentId: query.agent_id || null };
    return listConnections(db, String(org.id), user.id, scope);
  });

  app.get("/api/mcp/connections/:connection_id", async (request) => {
    const user = await currentUser(db, request, deps);
    return viewConnection(
      db,
      await requireVisibleConnection(db, param(request, "connection_id"), user.id),
    );
  });

  app.post("/api/mcp/connections/:connection_id/call", async (request) => {
    const user = await currentUser(db, request, deps);
    const connection = await requireVisibleConnection(
      db,
      param(request, "connection_id"),
      user.id,
    );
    const body = bodyOf(request);
    return callConnectionTool(services, connection, {
      tool: String(body.tool ?? ""),
      arguments: body.arguments,
    });
  });

  /** Values for a settings property marked `x-lookup`, searched with the credentials a Connect form holds. */
  app.post("/api/mcp/servers/:server_id/lookup", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    const body = bodyOf(request);
    const lookup = {
      property: String(body.property ?? ""),
      q: String(body.q ?? ""),
      credentials: body.credentials,
    };
    return lookupWithCredentials(services, String(org.id), param(request, "server_id"), lookup);
  });

  /** Values for a settings property marked `x-lookup`, searched with a saved login. */
  app.get("/api/mcp/connections/:connection_id/lookup", async (request) => {
    const user = await currentUser(db, request, deps);
    const connection = await requireVisibleConnection(
      db,
      param(request, "connection_id"),
      user.id,
    );
    const query = queryOf(request);
    return lookupWithLogin(services, connection, {
      property: query.property ?? "",
      q: query.q ?? "",
    });
  });

  app.put("/api/mcp/connections/:connection_id/settings", async (request) => {
    const user = await currentUser(db, request, deps);
    const connection = await requireVisibleConnection(
      db,
      param(request, "connection_id"),
      user.id,
    );
    return saveConnectionSettings(services, connection, bodyOf(request).settings);
  });

  app.delete("/api/mcp/connections/:connection_id", async (request, reply) => {
    const user = await currentUser(db, request, deps);
    const connection = await requireVisibleConnection(
      db,
      param(request, "connection_id"),
      user.id,
    );
    await deleteConnection(services, connection);
    return reply.code(204).send();
  });
}
