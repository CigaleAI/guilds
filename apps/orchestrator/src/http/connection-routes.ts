import { Type } from "@sinclair/typebox";
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
import type { AppDeps, RouteApp } from "./deps.js";
import { currentOrg, currentUser } from "./identity.js";

/** The path of one connector. */
const ServerParams = Type.Object({ server_id: Type.String() });

/** The path of one login. */
const ConnectionParams = Type.Object({ connection_id: Type.String() });

/** Which logins to list: the organisation's, or the ones that reach a guild or an agent. */
const ConnectionListQuery = Type.Object({
  guild_id: Type.Optional(Type.String()),
  agent_id: Type.Optional(Type.String()),
});

/** A tool called through a login: its name and its arguments. */
const ToolCallSchema = Type.Object({
  tool: Type.Optional(Type.String()),
  arguments: Type.Optional(Type.Unknown()),
});

/** A search for a settings property's values: the property and the text to match. */
const LookupFields = {
  property: Type.Optional(Type.String()),
  q: Type.Optional(Type.String()),
};

/** A lookup with the credentials a Connect form holds, which the connector's own rules check. */
const CredentialsLookupSchema = Type.Object({
  ...LookupFields,
  credentials: Type.Optional(Type.Unknown()),
});

/** A lookup with a saved login. */
const LoginLookupQuery = Type.Object(LookupFields);

/** A login's settings document, which the connector's settings schema checks. */
const ConnectionSettingsSchema = Type.Object({ settings: Type.Optional(Type.Unknown()) });

/** The connectors an organisation sees, and its members' logins to them: read, used, set up, and removed. */
export async function registerConnectionRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const services: ConnectionServices = { db, mcp: deps.mcp ?? null, masterKey: deps.masterKey };

  app.get("/api/mcp/servers", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    return listOrgServers(db, String(org.id));
  });

  app.get(
    "/api/mcp/servers/:server_id/logo",
    { schema: { params: ServerParams } },
    async (request, reply) => {
      await currentUser(db, request, deps);
      const logo = await readConnectorLogo(request.params.server_id);
      return reply
        .code(200)
        .header("content-type", "image/svg+xml")
        .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "private, max-age=3600")
        .send(logo);
    },
  );

  app.get(
    "/api/mcp/connections",
    { schema: { querystring: ConnectionListQuery } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const { query } = request;
      const scope = { guildId: query.guild_id || null, agentId: query.agent_id || null };
      return listConnections(db, String(org.id), user.id, scope);
    },
  );

  app.get(
    "/api/mcp/connections/:connection_id",
    { schema: { params: ConnectionParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      return viewConnection(
        db,
        await requireVisibleConnection(db, request.params.connection_id, user.id),
      );
    },
  );

  app.post(
    "/api/mcp/connections/:connection_id/call",
    { schema: { params: ConnectionParams, body: ToolCallSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const connection = await requireVisibleConnection(
        db,
        request.params.connection_id,
        user.id,
      );
      return callConnectionTool(services, connection, {
        tool: request.body.tool ?? "",
        arguments: request.body.arguments,
      });
    },
  );

  /** Values for a settings property marked `x-lookup`, searched with the credentials a Connect form holds. */
  app.post(
    "/api/mcp/servers/:server_id/lookup",
    { schema: { params: ServerParams, body: CredentialsLookupSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const body = request.body;
      const lookup = {
        property: body.property ?? "",
        q: body.q ?? "",
        credentials: body.credentials,
      };
      return lookupWithCredentials(services, String(org.id), request.params.server_id, lookup);
    },
  );

  /** Values for a settings property marked `x-lookup`, searched with a saved login. */
  app.get(
    "/api/mcp/connections/:connection_id/lookup",
    { schema: { params: ConnectionParams, querystring: LoginLookupQuery } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const connection = await requireVisibleConnection(
        db,
        request.params.connection_id,
        user.id,
      );
      return lookupWithLogin(services, connection, {
        property: request.query.property ?? "",
        q: request.query.q ?? "",
      });
    },
  );

  app.put(
    "/api/mcp/connections/:connection_id/settings",
    { schema: { params: ConnectionParams, body: ConnectionSettingsSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const connection = await requireVisibleConnection(
        db,
        request.params.connection_id,
        user.id,
      );
      return saveConnectionSettings(services, connection, request.body.settings);
    },
  );

  app.delete(
    "/api/mcp/connections/:connection_id",
    { schema: { params: ConnectionParams } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const connection = await requireVisibleConnection(
        db,
        request.params.connection_id,
        user.id,
      );
      await deleteConnection(services, connection);
      return reply.code(204).send();
    },
  );
}
