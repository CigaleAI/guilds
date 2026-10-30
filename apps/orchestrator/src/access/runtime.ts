import { listBindingsCovering } from "../db/bindings.js";
import { listMcpConnections, type McpConnectionRow } from "../db/mcp.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import { getSecret, listAgentSecrets } from "../db/secrets.js";
import { writeLog } from "../observability/log.js";
import { decryptPayload } from "../credentials/crypto.js";
import { secretValue } from "../credentials/validate.js";
import { McpDisconnectedError } from "../mcp/errors.js";
import type { ConnectorLogin, McpPool } from "../mcp/pool.js";
import { connectionTools, resolveConnectionTool, type ConnectionTool } from "../mcp/service.js";
import { MissingSecretError } from "../secrets/index.js";
import { listServers, type LoadedConnector } from "../connectors/servers.js";
import {
  ACCESS_NATIVE_TOOLS,
  enabledToolNames,
  resolveItem,
  resolvedMcp,
  resolvedTools,
  type ResolvableBinding,
  type Resolved,
} from "./index.js";
import type { AgentPlaceRow } from "../db/agents.js";
import type { RunMcpConnection, RunMcpTool, SecretRef } from "../db/schema/index.js";

export const PLATFORM_SEED_TOOLS = ACCESS_NATIVE_TOOLS;

/** A connection an agent reaches, with each tool it is offered and that tool's schema for the model. */
export type RuntimeMcpConnection = Omit<RunMcpConnection, "tools"> & {
  tools: Array<RunMcpTool & { schema: Record<string, unknown> }>;
};

export type RuntimeAccess = {
  tools: string[];
  secrets: SecretRef[];
  mcp: RuntimeMcpConnection[];
};

/** The db/ functions an agent's runtime access is resolved through, and the stored tool listings it reads, on `db`. */
function accessDatabase(db: Queryable) {
  return {
    listBindingsCovering: bindQuery(db, listBindingsCovering),
    listAgentSecrets: bindQuery(db, listAgentSecrets),
    getSecret: bindQuery(db, getSecret),
    listServers: bindQuery(db, listServers),
    listMcpConnections: bindQuery(db, listMcpConnections),
    connectionTools: bindQuery(db, connectionTools),
  };
}

export type AccessDatabase = ReturnType<typeof accessDatabase>;

export function resolveMcpTool(
  rows: ResolvableBinding[],
  namespaced: string,
  options: {
    serverEnabled: boolean;
    orgId?: string | null;
    guildId?: string | null;
    agentId?: string | null;
    viewScope?: string;
  },
): Resolved {
  const item = resolveItem(rows, "mcp_tool", namespaced, {
    orgId: options.orgId,
    guildId: options.guildId,
    agentId: options.agentId,
    viewScope: options.viewScope ?? "agent",
  });
  if (!options.serverEnabled) {
    return {
      catalog_kind: item.catalog_kind,
      catalog_id: item.catalog_id,
      enabled: false,
      source_scope: item.source_scope,
      connection_id: null,
      overlay: item.overlay,
    };
  }
  if (item.source_scope === null) {
    return {
      catalog_kind: "mcp_tool",
      catalog_id: namespaced,
      enabled: true,
      source_scope: null,
      connection_id: null,
      overlay: null,
    };
  }
  return item;
}

/**
 * The agent's environment as the run snapshot carries it: id, name, and description of each
 * secret, read through `db`, the dependencies object a unit test fakes.
 */
export async function agentSecretsThrough(db: AccessDatabase, agent: AgentPlaceRow): Promise<SecretRef[]> {
  const rows = await db.listAgentSecrets({
    orgId: agent.org_id,
    guildId: agent.guild_id,
    agentId: agent.id,
  });
  return rows.map((row) => ({ id: row.id, name: row.name, description: row.description }));
}

/**
 * The agent's environment as the run snapshot carries it: id, name, and description of each
 * secret.
 */
export async function agentSecrets(db: Queryable, agent: AgentPlaceRow): Promise<SecretRef[]> {
  return agentSecretsThrough(accessDatabase(db), agent);
}

type RuntimeScope = { orgId: string | null; guildId: string; agentId: string };

/** The pool an agent's logins list their tools through. */
type ToolSync = Pick<McpPool, "syncTools">;

/** A login and the tools it lists, for one connector the agent has on. */
type Listing = ConnectorLogin & { listed: ConnectionTool[] };

/** What an agent's logins are read through: its bindings, the servers it sees, and the logins covering it. */
type LoginReads = Pick<AccessDatabase, "listBindingsCovering" | "listServers" | "listMcpConnections">;

/**
 * The connected logins behind the MCP servers the agent has on, each with its server, read
 * through `db`, the dependencies object a unit test fakes. A server that is off for the agent,
 * or whose login is missing or not connected, has none.
 */
export async function agentLoginsThrough(db: LoginReads, agent: AgentPlaceRow): Promise<ConnectorLogin[]> {
  const scope: RuntimeScope = { orgId: agent.org_id, guildId: agent.guild_id, agentId: agent.id };
  const rows = await db.listBindingsCovering(scope);
  const connections = await loginsById(db, scope);
  const logins: ConnectorLogin[] = [];
  for (const [item, server] of resolvedMcp(rows, await db.listServers({ owner: { visibleTo: scope.orgId } }), scope)) {
    const connection = item.enabled && item.connection_id !== null ? connections.get(item.connection_id) : undefined;
    if (connection?.status === "connected") {
      logins.push({ connection, server });
    }
  }
  return logins;
}

/**
 * The connected logins behind the MCP servers the agent has on, each with its server. A server
 * that is off for the agent, or whose login is missing or not connected, has none.
 */
export async function agentLogins(db: Queryable, agent: AgentPlaceRow): Promise<ConnectorLogin[]> {
  return agentLoginsThrough(accessDatabase(db), agent);
}

/**
 * The connected login behind one catalog tool the agent is offered, or null
 * when the server or that tool is off for the agent, the login is not
 * connected, or the login's catalog does not list the tool.
 */
export async function agentToolConnection(
  db: AccessDatabase,
  agent: AgentPlaceRow,
  slug: string,
  remoteName: string,
): Promise<McpConnectionRow | null> {
  const login = (await agentLoginsThrough(db, agent)).find((item) => item.server.slug === slug);
  if (!login) {
    return null;
  }
  const scope: RuntimeScope = { orgId: agent.org_id, guildId: agent.guild_id, agentId: agent.id };
  const rows = await db.listBindingsCovering(scope);
  const tool = (await db.connectionTools(login.connection, login.server)).find(
    (item) => item.remote_name === remoteName,
  );
  if (!tool || !resolveMcpTool(rows, tool.namespaced_name, { serverEnabled: true, ...scope }).enabled) {
    return null;
  }
  return login.connection;
}

/**
 * The connected login a connector the agent has on resolves to, or null when it offers nothing:
 * off, with no login, or a login still pending. A disconnected login throws, except a platform
 * login an instance key serves, which is off while its integration is.
 */
function connectedLogin(
  item: Resolved,
  server: LoadedConnector,
  connections: Map<string, McpConnectionRow>,
): McpConnectionRow | null {
  const connection = item.enabled && item.connection_id !== null ? connections.get(item.connection_id) : undefined;
  if (connection?.status === "disconnected") {
    if (connection.owner_scope === "platform" && server.manifest.auth.instance) {
      return null;
    }
    throw new McpDisconnectedError(`${server.slug} is disconnected`);
  }
  return connection?.status === "connected" ? connection : null;
}

/**
 * The tools a login lists: synced when there is a pool, else the stored catalog. A sync that
 * finds the login disconnected throws; any other failed sync falls back to the stored catalog.
 */
async function loginTools(
  db: AccessDatabase,
  mcpPool: ToolSync | null,
  login: ConnectorLogin,
  agentId: string,
): Promise<ConnectionTool[]> {
  const { connection, server } = login;
  if (mcpPool !== null) {
    try {
      return (await mcpPool.syncTools(connection, server)).map((tool) => resolveConnectionTool(server, tool));
    } catch (error) {
      if (error instanceof McpDisconnectedError) {
        throw error;
      }
      writeLog("warn", "mcp tool sync failed; using stored catalog", {
        agent_id: agentId,
        operation: `mcp.sync.${server.slug}`,
        error_type: error instanceof Error ? error.name : "Error",
      }, error);
    }
  }
  return db.connectionTools(connection, server);
}

/** The login's entry in the run's MCP access: its tools that resolve On, or null when none does. */
function offeredLogin(rows: ResolvableBinding[], listing: Listing, scope: RuntimeScope): RuntimeMcpConnection | null {
  const offered = listing.listed
    .filter((tool) => resolveMcpTool(rows, tool.namespaced_name, { serverEnabled: true, ...scope }).enabled)
    .map((tool) => ({ name: tool.namespaced_name, remote_name: tool.remote_name, schema: tool.schema }));
  if (!offered.length) {
    return null;
  }
  return { connection_id: listing.connection.id, server_id: listing.server.id, slug: listing.server.slug, tools: offered };
}

/** The logins covering the agent, by id. */
async function loginsById(db: Pick<AccessDatabase, "listMcpConnections">, scope: RuntimeScope): Promise<Map<string, McpConnectionRow>> {
  const logins = await db.listMcpConnections(scope);
  return new Map(logins.map((connection) => [connection.id, connection]));
}

/**
 * The tools, secrets, and connections the agent is granted, read through `db`, the dependencies
 * object a unit test fakes; each login's tools are synced through `mcpPool` when there is one.
 */
export async function agentRuntimeThrough(
  db: AccessDatabase,
  agent: AgentPlaceRow,
  options: { mcpPool?: ToolSync | null } = {},
): Promise<RuntimeAccess> {
  const scope: RuntimeScope = {
    orgId: agent.org_id,
    guildId: agent.guild_id,
    agentId: agent.id,
  };
  const rows = await db.listBindingsCovering(scope);
  const tools = enabledToolNames(resolvedTools(rows, scope));
  const metas = await agentSecretsThrough(db, agent);
  const servers = await db.listServers({ owner: { visibleTo: scope.orgId } });
  const connections = await loginsById(db, scope);
  const listings: Listing[] = [];
  for (const [item, server] of resolvedMcp(rows, servers, scope)) {
    const connection = connectedLogin(item, server, connections);
    if (connection !== null) {
      const listed = await loginTools(db, options.mcpPool ?? null, { connection, server }, scope.agentId);
      listings.push({ connection, server, listed });
    }
  }
  // A sync writes an Off binding for each tool it lists for the first time: tools resolve against those.
  const toolRows = listings.length ? await db.listBindingsCovering(scope) : rows;
  const mcp = listings
    .map((listing) => offeredLogin(toolRows, listing, scope))
    .filter((entry) => entry !== null);
  return { tools, secrets: metas, mcp };
}

/**
 * The tools, secrets, and connections the agent is granted; each login's tools are synced through
 * `mcpPool` when there is one, else read as last stored.
 */
export async function agentRuntime(
  db: Queryable,
  agent: AgentPlaceRow,
  mcpPool: ToolSync | null,
): Promise<RuntimeAccess> {
  return agentRuntimeThrough(accessDatabase(db), agent, { mcpPool });
}

/**
 * The environment with each alias set to the value of the secret it names, when that secret is in
 * it; an alias wins over a variable of its own name.
 */
export function applySecretAliases(
  env: Record<string, string>,
  aliases: Record<string, string>,
): Record<string, string> {
  const aliased = { ...env };
  for (const [alias, source] of Object.entries(aliases)) {
    if (source in env) {
      aliased[alias] = env[source]!;
    }
  }
  return aliased;
}

/**
 * The value of each secret, by name, read through `db`, the dependencies object a unit test
 * fakes; a `MissingSecretError` names the first that is gone or cannot be decrypted.
 */
export async function snapshotEnvValuesThrough(
  db: AccessDatabase,
  secretRefs: SecretRef[],
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const { id, name } of secretRefs) {
    const secret = await db.getSecret(id);
    if (secret === null || secret === undefined) {
      throw new MissingSecretError(name);
    }
    let value: string;
    try {
      value = secretValue(decryptPayload(secret.ciphertext as Buffer, secret.nonce as Buffer));
    } catch {
      throw new MissingSecretError(name);
    }
    values[name] = value;
  }
  return values;
}

/**
 * The value of each secret, by name; a `MissingSecretError` names the first that is gone or
 * cannot be decrypted.
 */
export async function snapshotEnvValues(
  db: Queryable,
  secretRefs: SecretRef[],
): Promise<Record<string, string>> {
  return snapshotEnvValuesThrough(accessDatabase(db), secretRefs);
}
