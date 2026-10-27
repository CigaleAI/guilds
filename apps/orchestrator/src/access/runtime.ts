import { listMcpServers } from "../connectors/servers.js";
import { listBindingsCovering } from "../db/bindings.js";
import { listMcpConnections, listMcpTools } from "../db/mcp.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import { getSecret, listAgentSecrets } from "../db/secrets.js";
import { writeLog } from "../observability/log.js";
import { decryptPayload } from "../credentials/crypto.js";
import { secretValue } from "../credentials/validate.js";
import {
  listedFromRows,
  mcpSchema,
  McpDisconnectedError,
  type ListedTool,
  type McpPool,
} from "../mcp/index.js";
import { MissingSecretError } from "../secrets/index.js";
import { serverManifest } from "../connectors/load.js";
import { ACCESS_NATIVE_TOOLS, enabledToolNames, resolveItem, resolvedMcp, resolvedTools, type Resolved } from "./index.js";

export const PLATFORM_SEED_TOOLS = ACCESS_NATIVE_TOOLS;

export type RuntimeAccess = {
  tools: string[];
  secrets: Array<Record<string, string>>;
  mcp: Array<Record<string, unknown>>;
};

/** The db/ functions an agent's runtime access is resolved through, on `db`. */
export function accessDatabase(db: Queryable) {
  return {
    listBindingsCovering: bindQuery(db, listBindingsCovering),
    listAgentSecrets: bindQuery(db, listAgentSecrets),
    getSecret: bindQuery(db, getSecret),
    listMcpServers: bindQuery(db, listMcpServers),
    listMcpConnections: bindQuery(db, listMcpConnections),
    listMcpTools: bindQuery(db, listMcpTools),
  };
}

export type AccessDatabase = ReturnType<typeof accessDatabase>;

export function resolveMcpTool(
  rows: Array<Record<string, unknown>>,
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

/** The agent's environment as the run snapshot carries it: id, name, and description of each secret. */
export async function agentSecrets(db: AccessDatabase, agent: Record<string, unknown>): Promise<Array<Record<string, string>>> {
  const rows = await db.listAgentSecrets({
    orgId: String(agent.org_id),
    guildId: String(agent.guild_id),
    agentId: String(agent.id),
  });
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ""),
  }));
}

/**
 * The connected login behind an enabled MCP server for the agent, or null
 * when the server is off or the login is not connected.
 */
export async function agentMcpConnection(
  db: AccessDatabase,
  agent: Record<string, unknown>,
  slug: string,
): Promise<Record<string, unknown> | null> {
  const orgId = (agent.org_id as string | null | undefined) ?? null;
  const guildId = String(agent.guild_id);
  const agentId = String(agent.id);
  const scope = { orgId, guildId, agentId };
  const server = (await db.listMcpServers(orgId)).find((row) => row.slug === slug);
  if (!server) {
    return null;
  }
  const rows = await db.listBindingsCovering(scope);
  const item = resolveItem(rows, "mcp", String(server.id), scope);
  if (!item.enabled || item.connection_id === null) {
    return null;
  }
  const connection = (await db.listMcpConnections(scope)).find(
    (row) => row.id === item.connection_id,
  );
  if (connection?.status !== "connected") {
    return null;
  }
  return connection;
}

/**
 * The connected login behind one catalog tool the agent is offered, or null
 * when the server or that tool is off for the agent, the login is not
 * connected, or the login's catalog does not list the tool.
 */
export async function agentToolConnection(
  db: AccessDatabase,
  agent: Record<string, unknown>,
  slug: string,
  remoteName: string,
): Promise<Record<string, unknown> | null> {
  const connection = await agentMcpConnection(db, agent, slug);
  if (!connection) {
    return null;
  }
  const orgId = (agent.org_id as string | null | undefined) ?? null;
  const guildId = String(agent.guild_id);
  const agentId = String(agent.id);
  const scope = { orgId, guildId, agentId };
  const server = (await db.listMcpServers(orgId)).find((row) => row.slug === slug);
  if (!server) {
    return null;
  }
  const rows = await db.listBindingsCovering(scope);
  const tool = listedFromRows(await db.listMcpTools(String(connection.id))).find(
    (row) => row.remote_name === remoteName,
  );
  if (!tool || !resolveMcpTool(rows, tool.namespaced_name, { serverEnabled: true, ...scope }).enabled) {
    return null;
  }
  return connection;
}

type RuntimeScope = { orgId: string | null; guildId: string; agentId: string };

type ToolSync = McpPool | { syncTools?: McpPool["syncTools"] } | null;

/** A login and the tools it lists, for one connector the agent has on. */
type Listing = { connection: Record<string, unknown>; server: Record<string, unknown>; listed: ListedTool[] };

/**
 * The connected login a connector the agent has on resolves to, or null when it offers nothing:
 * off, with no login, or a login still pending. A disconnected login throws, except a platform
 * login an instance key serves, which is off while its integration is.
 */
function connectedLogin(
  item: Resolved,
  server: Record<string, unknown>,
  connections: Map<string, Record<string, unknown>>,
): Record<string, unknown> | null {
  const connection = item.enabled && item.connection_id !== null ? connections.get(item.connection_id) : undefined;
  if (connection?.status === "disconnected") {
    if (connection.owner_scope === "platform" && serverManifest(server)?.auth.instance) {
      return null;
    }
    throw new McpDisconnectedError(`${server.slug} is disconnected`);
  }
  return connection?.status === "connected" ? connection : null;
}

/** The tools a login lists: synced when the pool can, else the stored catalog. A sync that fails falls back to it. */
async function loginTools(db: AccessDatabase, mcpPool: ToolSync, listing: Omit<Listing, "listed">, agentId: string) {
  const { connection, server } = listing;
  try {
    const synced = await mcpPool?.syncTools?.(db as never, connection, server);
    if (synced) {
      return synced;
    }
  } catch (error) {
    if (error instanceof McpDisconnectedError) {
      throw error;
    }
    writeLog("warn", "mcp tool sync failed; using stored catalog", {
      agent_id: agentId,
      operation: `mcp.sync.${String(server.slug)}`,
      error_type: error instanceof Error ? error.name : "Error",
    }, error);
  }
  return listedFromRows(await db.listMcpTools(String(connection.id)));
}

/** The login's entry in the run's MCP access: its tools that resolve On, or null when none does. */
function offeredLogin(rows: Array<Record<string, unknown>>, listing: Listing, scope: RuntimeScope): Record<string, unknown> | null {
  const offered = listing.listed
    .filter((tool) => resolveMcpTool(rows, tool.namespaced_name, { serverEnabled: true, ...scope }).enabled)
    .map((tool) => ({ name: tool.namespaced_name, remote_name: tool.remote_name, schema: mcpSchema(tool) }));
  if (!offered.length) {
    return null;
  }
  return { connection_id: listing.connection.id, server_id: listing.server.id, slug: listing.server.slug, tools: offered };
}

/** The logins covering the agent, by id. */
async function loginsById(db: AccessDatabase, scope: RuntimeScope): Promise<Map<string, Record<string, unknown>>> {
  const logins = await db.listMcpConnections(scope);
  return new Map(logins.map((connection) => [String(connection.id), connection]));
}

export async function agentRuntime(
  db: AccessDatabase,
  agent: Record<string, unknown>,
  options: { mcpPool?: ToolSync } = {},
): Promise<RuntimeAccess> {
  const scope: RuntimeScope = {
    orgId: (agent.org_id as string | null | undefined) ?? null,
    guildId: String(agent.guild_id),
    agentId: String(agent.id),
  };
  const rows = await db.listBindingsCovering(scope);
  const tools = enabledToolNames(resolvedTools(rows, scope));
  const metas = await agentSecrets(db, agent);
  const servers = await db.listMcpServers(scope.orgId);
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
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  return { tools, secrets: metas, mcp };
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

export async function snapshotEnvValues(
  db: AccessDatabase,
  secretRefs: Array<Record<string, string>>,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const ref of secretRefs) {
    const secretId = ref.id;
    const name = ref.name;
    if (typeof secretId !== "string" || typeof name !== "string") {
      throw new MissingSecretError(typeof name === "string" ? name : "secret");
    }
    const secret = await db.getSecret(secretId);
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
