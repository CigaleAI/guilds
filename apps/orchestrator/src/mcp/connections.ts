import { readFile } from "node:fs/promises";
import { requireVisibleAgent } from "../agents/access.js";
import { connectFailure, tokenCredentials } from "../connectors/connect.js";
import { installedConnectors } from "../connectors/index.js";
import { settingsComplete, validateSettings } from "../connectors/settings.js";
import { logoPath } from "../connectors/view.js";
import { bindingItem, connectionMetadata, serverItem } from "../credentials/items.js";
import { listBindingsForConnection } from "../db/bindings.js";
import { getMcpServer, listMcpServers } from "../db/connectors.js";
import { isPlainRecord } from "../db/json.js";
import {
  deleteMcpConnection,
  getMcpConnection,
  listMcpConnections,
  updateMcpConnectionSettings,
  type McpConnectionRow,
} from "../db/mcp.js";
import type { Queryable } from "../db/pg.js";
import { requireVisibleGuild } from "../guilds/access.js";
import { awaitingSettings, mcpDatabase, type McpPool } from "./index.js";
import { callOwnedConnectionTool } from "./operator-call.js";
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

/** A search for a settings property's values: the property marked `x-lookup`, and the text searched for. */
export type SettingsLookup = { property: string; q: string };

/** A lookup made from a Connect form, with the credentials the form holds before they are saved. */
export type CredentialsLookup = SettingsLookup & { credentials: unknown };

type Item = Record<string, unknown>;

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

export async function listOrgServers(db: Queryable, orgId: string): Promise<{ servers: Item[] }> {
  return { servers: (await listMcpServers(db, orgId)).map((row) => serverItem(row)) };
}

/** An installed connector's logo, as SVG. */
export async function readConnectorLogo(serverId: string): Promise<Buffer> {
  const file = logoPath(installedConnectors().byId(serverId));
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
): Promise<{ connections: Item[] }> {
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

/** A login with the bindings that use it. */
export async function viewConnection(db: Queryable, connection: McpConnectionRow): Promise<Item> {
  const bindings = await listBindingsForConnection(db, connection.id);
  return { ...connectionMetadata(connection), bindings: bindings.map((item) => bindingItem(item)) };
}

/** Calls one of a connected login's tools as the operator. */
export async function callConnectionTool(
  services: ConnectionServices,
  connection: McpConnectionRow,
  call: ConnectionToolCall,
): Promise<Item> {
  const server = await requireServer(services.db, connection.mcp_server_id);
  const mcp = poolOf(services, "tool calls are unavailable");
  const tool = call.tool.trim();
  if (!tool) {
    throw new ConnectionError(422, "tool is required");
  }
  if (call.arguments !== undefined && !isPlainRecord(call.arguments)) {
    throw new ConnectionError(422, "arguments must be an object");
  }
  return callOwnedConnectionTool({
    db: mcpDatabase(services.db),
    mcp,
    connection,
    server,
    tool,
    arguments: call.arguments ?? {},
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
  const { property, q } = requireLookup(lookup);
  const credentials = isPlainRecord(lookup.credentials) ? lookup.credentials : {};
  try {
    return {
      options: await mcp.lookup(server, property, q, tokenCredentials(server, credentials)),
    };
  } catch (error) {
    connectFailure(error, server);
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
      options: await mcp.lookupLogin(mcpDatabase(services.db), connection, server, property, q),
    };
  } catch (error) {
    connectFailure(error, server);
  }
}

/**
 * Stores a login's settings after checking them against the manifest's schema and with the
 * connector's `validate`. A login that waited for its settings connects and lists its tools.
 */
export async function saveConnectionSettings(
  services: ConnectionServices,
  connection: McpConnectionRow,
  settings: unknown,
): Promise<Item> {
  assertNotPlatform(connection);
  const server = await requireServer(services.db, connection.mcp_server_id);
  const schema = installedConnectors().forServer(server)?.manifest.settings_schema;
  if (!schema) {
    throw new ConnectionError(422, "this connector has no settings");
  }
  if (connection.status !== "connected" && !awaitingSettings(connection)) {
    throw new ConnectionError(409, "sign in before saving settings");
  }
  const mcp = poolOf(services, "settings are unavailable");
  const valid = validateSettings(schema, settings ?? null);
  let accountHint = "";
  try {
    accountHint = await mcp.validateLogin(mcpDatabase(services.db), connection, server, valid);
  } catch (error) {
    connectFailure(error, server);
  }
  const connect = awaitingSettings(connection) && settingsComplete(schema, valid);
  const row = await updateMcpConnectionSettings(services.db, connection.id, valid, new Date(), {
    connect,
    accountHint,
  });
  if (row === null) {
    throw new ConnectionError(404, "connection not found");
  }
  mcp.forget(row.id);
  if (row.status === "connected") {
    await syncAfterSettings(services, mcp, row, server);
  }
  return connectionMetadata(row);
}

/** Lists a login's tools once its settings are saved; a failed listing waits for the next sync. */
async function syncAfterSettings(
  services: ConnectionServices,
  mcp: McpPool,
  row: McpConnectionRow,
  server: Record<string, unknown>,
): Promise<void> {
  try {
    await mcp.syncTools(mcpDatabase(services.db), row, server, { force: true, validate: false });
  } catch {
    // The settings stand; the login's tools list on the next sync.
  }
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
