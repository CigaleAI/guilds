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
import { GITHUB_SLUG } from "../github/index.js";
import { serverManifest } from "../connectors/load.js";
import { ACCESS_NATIVE_TOOLS, enabledToolNames, resolveItem, resolvedMcp, resolvedTools, type Resolved } from "./index.js";

export const PLATFORM_SEED_TOOLS = ACCESS_NATIVE_TOOLS;

export type RuntimeAccess = {
  tools: string[];
  secrets: Array<Record<string, string>>;
  mcp: Array<Record<string, unknown>>;
};

export type AccessDatabase = {
  listBindingsCovering(options: {
    orgId?: string | null;
    guildId?: string | null;
    agentId?: string | null;
  }): Promise<Array<Record<string, unknown>>>;
  listAgentSecrets(options: {
    orgId: string;
    guildId: string;
    agentId: string;
  }): Promise<Array<Record<string, unknown>>>;
  getSecret?(secretId: string): Promise<Record<string, unknown> | null>;
  listMcpServers?(orgId?: string | null): Promise<Array<Record<string, unknown>>>;
  listMcpConnections?(options: {
    orgId?: string | null;
    guildId?: string | null;
    agentId?: string | null;
  }): Promise<Array<Record<string, unknown>>>;
  listMcpTools?(connectionId: string): Promise<Array<Record<string, unknown>>>;
};

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
  const server = (await (db.listMcpServers?.(orgId) ?? [])).find((row) => row.slug === slug);
  if (!server) {
    return null;
  }
  const rows = await db.listBindingsCovering(scope);
  const item = resolveItem(rows, "mcp", String(server.id), scope);
  if (!item.enabled || item.connection_id === null) {
    return null;
  }
  const connection = (await (db.listMcpConnections?.(scope) ?? [])).find(
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
  const server = (await (db.listMcpServers?.(orgId) ?? [])).find((row) => row.slug === slug);
  if (!server) {
    return null;
  }
  const rows = await db.listBindingsCovering(scope);
  const tool = listedFromRows(await (db.listMcpTools?.(String(connection.id)) ?? [])).find(
    (row) => row.remote_name === remoteName,
  );
  if (!tool || !resolveMcpTool(rows, tool.namespaced_name, { serverEnabled: true, ...scope }).enabled) {
    return null;
  }
  return connection;
}

export async function agentRuntime(
  db: AccessDatabase,
  agent: Record<string, unknown>,
  options: { mcpPool?: McpPool | { syncTools?: McpPool["syncTools"] } | null } = {},
): Promise<RuntimeAccess> {
  const guildId = String(agent.guild_id);
  const agentId = String(agent.id);
  const orgId = (agent.org_id as string | null | undefined) ?? null;
  const rows = await db.listBindingsCovering({ orgId, guildId, agentId });
  const tools = enabledToolNames(resolvedTools(rows, { orgId, guildId, agentId }));
  const metas = await agentSecrets(db, agent);
  const servers = await (db.listMcpServers?.(orgId) ?? []);
  const connections = new Map<string, Record<string, unknown>>();
  for (const connection of await (db.listMcpConnections?.({ orgId, guildId, agentId }) ?? [])) {
    connections.set(String(connection.id), connection);
  }
  const mcp: Array<Record<string, unknown>> = [];
  const mcpPool = options.mcpPool ?? null;
  for (const [item, server] of resolvedMcp(rows, servers, { orgId, guildId, agentId })) {
    // GitHub offers no tools: coding runs reach it through their guild's repositories.
    if (!item.enabled || item.connection_id === null || server.slug === GITHUB_SLUG) {
      continue;
    }
    const connection = connections.get(item.connection_id);
    if (connection === undefined) {
      continue;
    }
    if (connection.status === "disconnected") {
      // A platform login an instance key serves is off while its integration is: its tools are left out.
      if (connection.owner_scope === "platform" && serverManifest(server)?.auth.instance) {
        continue;
      }
      throw new McpDisconnectedError(`${server.slug} is disconnected`);
    }
    if (connection.status !== "connected") {
      continue;
    }
    let listed: ListedTool[] | null = null;
    if (mcpPool?.syncTools) {
      try {
        listed = await mcpPool.syncTools(db as never, connection, server);
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
    }
    if (listed === null) {
      listed = listedFromRows(await (db.listMcpTools?.(String(connection.id)) ?? []));
    }
    const offered: Array<Record<string, unknown>> = [];
    for (const tool of listed) {
      const resolved = resolveMcpTool(rows, tool.namespaced_name, {
        serverEnabled: true,
        orgId,
        guildId,
        agentId,
      });
      if (!resolved.enabled) {
        continue;
      }
      offered.push({
        name: tool.namespaced_name,
        remote_name: tool.remote_name,
        schema: mcpSchema(tool),
      });
    }
    if (offered.length) {
      mcp.push({
        connection_id: connection.id,
        server_id: server.id,
        slug: server.slug,
        tools: offered,
      });
    }
  }
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
    const secret = db.getSecret ? await db.getSecret(secretId) : null;
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
