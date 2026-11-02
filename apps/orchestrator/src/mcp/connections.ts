import { readFile } from "node:fs/promises";
import { requireVisibleAgent } from "../agents/access.js";
import { tokenCredentials, translateConnectFailure } from "./connect-token.js";
import {
  getMcpServer,
  listServers,
  logoPath,
  serverSettings,
} from "../connectors/servers.js";
import { validateSettings } from "../connectors/settings.js";
import { bindingItem, connectionMetadata, serverItem, type BindingView, type ConnectionView, type ServerView } from "./view.js";
import { listBindingsForConnection } from "../db/bindings.js";
import {
  deleteMcpConnection,
  getMcpConnection,
  listMcpConnections,
  updateMcpConnectionSettings,
  type McpConnectionRow,
} from "../db/mcp.js";
import type { Queryable } from "../db/pg.js";
import { GITHUB_SLUG } from "../github/index.js";
import { requireVisibleGuild } from "../guilds/access.js";
import { isJsonObject, type JsonObject } from "../lib/json.js";
import { relistTools, type McpPool, type SettingsLookup } from "./pool.js";
import { awaitingSettings } from "../connectors/login.js";
import { callOwnedConnectionTool, type OperatorToolResult } from "./operator-call.js";
import { ConnectionError, seesConnection, serverVisible } from "./visibility.js";

/** What an operator's connector logins are read, used and changed through, built once from the app's services. */
export type ConnectionServices = {
  db: Queryable;
  /** The pool that talks to the connectors; absent on a box that calls none. */
  mcp: McpPool | null;
  masterKey: Buffer | undefined;
};

/** Which logins a listing shows: the organisation's, or the ones a guild or an agent holds too. */
export type ConnectionListScope = { guildId: string | null; agentId: string | null };

/** A tool call an operator makes with a login: the tool, and its arguments before validation. */
export type ConnectionToolCall = { tool: string; arguments: unknown };

/** A lookup made from a Connect form, with the credentials the form holds before they are saved. */
export type CredentialsLookup = SettingsLookup & { credentials: unknown };

/** A login as the API shows it, with the bindings that use it. */
export type BoundConnectionView = ConnectionView & { bindings: BindingView[] };

function poolOf(services: ConnectionServices, unavailable: string): McpPool {
  if (services.mcp === null) {
    throw new ConnectionError(409, unavailable);
  }
  return services.mcp;
}

async function requireServer(db: Queryable, serverId: string) {
  const server = await getMcpServer(db, serverId);
  if (server === null) {
    throw new ConnectionError(404, "mcp server not found");
  }
  return server;
}

function requireLookup(lookup: SettingsLookup): SettingsLookup {
  const property = lookup.property.trim();
  const q = lookup.q.trim();
  if (!property || !q) {
    throw new ConnectionError(422, "property and q are required");
  }
  return { property, q };
}

/** Refuses changing a login the platform owns. */
function assertNotPlatform(connection: McpConnectionRow): void {
  if (connection.owner_scope === "platform") {
    throw new ConnectionError(400, "platform-owned credentials cannot be changed here");
  }
}

export async function listOrgServers(db: Queryable, orgId: string): Promise<{ servers: ServerView[] }> {
  return { servers: (await listServers(db, { owner: { visibleTo: orgId } })).map((row) => serverItem(row)) };
}

/** An installed connector's logo, as SVG. */
export async function readConnectorLogo(serverId: string): Promise<Buffer> {
  const file = logoPath(serverId);
  if (file === null) {
    throw new ConnectionError(404, "logo not found");
  }
  return readFile(file);
}

/** The organisation's logins, with those of a guild or agent the user sees when the scope names one. */
export async function listConnections(
  db: Queryable,
  orgId: string,
  userId: string,
  scope: ConnectionListScope,
): Promise<{ connections: ConnectionView[] }> {
  if (scope.guildId) {
    await requireVisibleGuild(db, scope.guildId, userId);
  }
  if (scope.agentId) {
    await requireVisibleAgent(db, scope.agentId, userId);
  }
  const rows = await listMcpConnections(db, { orgId, ...scope });
  return { connections: rows.map((row) => connectionMetadata(row)) };
}

/** A login the user sees; any other is a 404. */
export async function requireVisibleConnection(
  db: Queryable,
  connectionId: string,
  userId: string,
): Promise<McpConnectionRow> {
  const row = await getMcpConnection(db, connectionId);
  if (row === null || !(await seesConnection(db, row, userId))) {
    throw new ConnectionError(404, "connection not found");
  }
  return row;
}

/** A GitHub login the user sees and that is not the platform's; any other is a 404. */
export async function requireVisibleGithubConnection(
  db: Queryable,
  connectionId: string,
  userId: string,
): Promise<McpConnectionRow> {
  const connection = await getMcpConnection(db, connectionId);
  if (connection === null) {
    throw new ConnectionError(404, "connection not found");
  }
  const server = await getMcpServer(db, connection.mcp_server_id);
  if (server?.slug !== GITHUB_SLUG) {
    throw new ConnectionError(422, "connection is not a GitHub connection");
  }
  if (connection.owner_scope === "platform" || !(await seesConnection(db, connection, userId))) {
    throw new ConnectionError(404, "connection not found");
  }
  return connection;
}

/** A login with the bindings that use it. */
export async function viewConnection(db: Queryable, connection: McpConnectionRow): Promise<BoundConnectionView> {
  const bindings = await listBindingsForConnection(db, connection.id);
  return { ...connectionMetadata(connection), bindings: bindings.map((item) => bindingItem(item)) };
}

/** Calls one of a connected login's tools as the operator. */
export async function callConnectionTool(
  services: ConnectionServices,
  connection: McpConnectionRow,
  call: ConnectionToolCall,
): Promise<OperatorToolResult> {
  const server = await requireServer(services.db, connection.mcp_server_id);
  const mcp = poolOf(services, "tool calls are unavailable");
  const tool = call.tool.trim();
  if (!tool) {
    throw new ConnectionError(422, "tool is required");
  }
  const arguments_ = call.arguments ?? {};
  if (!isJsonObject(arguments_)) {
    throw new ConnectionError(422, "arguments must be an object");
  }
  return callOwnedConnectionTool({
    mcp,
    connection,
    server,
    tool,
    arguments: arguments_,
    ...(services.masterKey ? { masterKey: services.masterKey } : {}),
  });
}

/** Values for a settings property marked `x-lookup`, searched with the credentials a Connect form holds. */
export async function lookupWithCredentials(
  services: ConnectionServices,
  orgId: string,
  serverId: string,
  lookup: CredentialsLookup,
): Promise<{ options: unknown }> {
  const server = await getMcpServer(services.db, serverId);
  if (server === null || server.enabled === false || !serverVisible(server, orgId)) {
    throw new ConnectionError(404, "mcp server not found");
  }
  const mcp = poolOf(services, "lookups are unavailable");
  const search = requireLookup(lookup);
  const credentials = isJsonObject(lookup.credentials) ? lookup.credentials : {};
  try {
    return {
      options: await mcp.lookup(server, search, tokenCredentials(server, credentials)),
    };
  } catch (error) {
    throw translateConnectFailure(error, server);
  }
}

/** Values for a settings property marked `x-lookup`, searched with a saved login. */
export async function lookupWithLogin(
  services: ConnectionServices,
  connection: McpConnectionRow,
  lookup: SettingsLookup,
): Promise<{ options: unknown }> {
  const server = await requireServer(services.db, connection.mcp_server_id);
  const mcp = poolOf(services, "lookups are unavailable");
  const { property, q } = requireLookup(lookup);
  try {
    return {
      options: await mcp.lookupLogin(connection, server, property, q),
    };
  } catch (error) {
    throw translateConnectFailure(error, server);
  }
}

/**
 * Stores a login's settings after checking them against the manifest's schema and with the
 * connector's `validate`. A login that waited for its settings connects and lists its tools.
 */
export async function saveConnectionSettings(
  services: ConnectionServices,
  connection: McpConnectionRow,
  settings: JsonObject,
): Promise<ConnectionView> {
  assertNotPlatform(connection);
  const server = await requireServer(services.db, connection.mcp_server_id);
  const schema = serverSettings(server);
  if (!schema) {
    throw new ConnectionError(422, "this connector has no settings");
  }
  if (connection.status !== "connected" && !awaitingSettings(connection)) {
    throw new ConnectionError(409, "sign in before saving settings");
  }
  const mcp = poolOf(services, "settings are unavailable");
  // The check refuses settings that lack a property the schema requires, so a login waiting
  // for its settings connects with any it accepts.
  validateSettings(schema, settings);
  let accountHint: string;
  try {
    accountHint = await mcp.validateLogin(connection, server, settings);
  } catch (error) {
    throw translateConnectFailure(error, server);
  }
  const row = await updateMcpConnectionSettings(
    services.db,
    connection.id,
    awaitingSettings(connection)
      ? { settings, status: "connected", account_hint: accountHint }
      : { settings, account_hint: accountHint },
    new Date(),
  );
  if (row === null) {
    throw new ConnectionError(404, "connection not found");
  }
  mcp.forget(row.id);
  if (row.status === "connected") {
    await relistTools(mcp, row, server, { force: true, validate: false });
  }
  return connectionMetadata(row);
}

/** Deletes a login the platform does not own. */
export async function deleteConnection(
  services: ConnectionServices,
  connection: McpConnectionRow,
): Promise<void> {
  assertNotPlatform(connection);
  if ((await deleteMcpConnection(services.db, connection.id)) === null) {
    throw new ConnectionError(404, "connection not found");
  }
  services.mcp?.forget(connection.id);
}
