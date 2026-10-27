import { accessPayload, mcpToolView, resolvedMcp } from "./index.js";
import { resolveMcpTool } from "./runtime.js";
import { manifestTools } from "../connectors/load.js";
import { isPlainRecord } from "../db/json.js";
import { listedFromRows, type McpDatabase, type McpPool } from "../mcp/index.js";
import type { LoadedConnector } from "../connectors/load.js";
import type { McpConnectionRow } from "../db/mcp.js";

function visibleServers(
  servers: LoadedConnector[],
  connections: McpConnectionRow[],
): LoadedConnector[] {
  const connected = new Set(connections.map((row) => String(row.mcp_server_id)));
  return servers.filter((server) => server.enabled || connected.has(server.id));
}

/**
 * Each connection's listed tools, by connection id: synced from its server while it is connected
 * and the pool can sync, else as last stored. A connection whose server the scope does not see is
 * left out.
 */
async function listConnectionTools(
  db: McpDatabase,
  mcp: McpPool | { syncTools?: McpPool["syncTools"] } | null | undefined,
  connections: McpConnectionRow[],
  servers: LoadedConnector[],
): Promise<Record<string, unknown[]>> {
  const serversById = new Map(servers.map((server) => [server.id, server]));
  const rawListed: Record<string, unknown[]> = {};
  for (const connection of connections) {
    const server = serversById.get(connection.mcp_server_id);
    if (server === undefined) {
      continue;
    }
    if (connection.status === "connected" && mcp?.syncTools) {
      try {
        rawListed[connection.id] = await mcp.syncTools(db, connection, server);
        continue;
      } catch {
        /* use stored rows */
      }
    }
    rawListed[connection.id] = listedFromRows(await db.listMcpTools(connection.id));
  }
  return rawListed;
}

/** The tools, connectors and bindings a scope sees, with each listed tool resolved for it. */
export async function loadAccessView(
  db: McpDatabase,
  options: {
    orgId?: string | null;
    guildId?: string | null;
    agentId?: string | null;
    viewScope: string;
    mcp?: McpPool | { syncTools?: McpPool["syncTools"] } | null;
  },
): Promise<Record<string, unknown>> {
  const scope = {
    orgId: options.orgId ?? null,
    guildId: options.guildId ?? null,
    agentId: options.agentId ?? null,
  };
  const connections = await db.listMcpConnections(scope);
  const servers = visibleServers(await db.listMcpServers(scope.orgId), connections);
  const rawListed = await listConnectionTools(db, options.mcp, connections, servers);
  // Read after the syncs: a sync writes an Off binding for each tool it lists for the first time.
  const rows = await db.listBindingsCovering(scope);
  const listedTools: Record<string, Array<Record<string, unknown>>> = {};
  for (const [item, server] of resolvedMcp(rows, servers, {
    orgId: scope.orgId,
    guildId: scope.guildId,
    agentId: scope.agentId,
    viewScope: options.viewScope,
  })) {
    const key = item.connection_id ?? `catalog:${server.id}`;
    if (item.connection_id !== null) {
      listedTools[key] = (rawListed[item.connection_id] ?? []).map((tool) => {
        const record = isPlainRecord(tool) ? tool : {};
        const namespaced = String(record.namespaced_name ?? record.name ?? "");
        const resolved = resolveMcpTool(rows, namespaced, {
          serverEnabled: item.enabled,
          orgId: scope.orgId,
          guildId: scope.guildId,
          agentId: scope.agentId,
          viewScope: options.viewScope,
        });
        return mcpToolView(resolved, record, { serverSource: item.source_scope });
      });
      continue;
    }
    listedTools[key] = manifestTools(server).map((tool) => {
      const namespaced = String(tool.namespaced_name);
      const resolved = resolveMcpTool(rows, namespaced, {
        serverEnabled: item.enabled,
        orgId: scope.orgId,
        guildId: scope.guildId,
        agentId: scope.agentId,
        viewScope: options.viewScope,
      });
      return mcpToolView(
        {
          ...resolved,
          enabled: resolved.source_scope ? resolved.enabled : tool.default_enabled && item.enabled,
        },
        {
          namespaced_name: tool.namespaced_name,
          remote_name: tool.remote_name,
          description: tool.description,
          input_schema: tool.input_schema,
        },
        { serverSource: item.source_scope },
      );
    });
  }
  return accessPayload({
    rows,
    orgId: scope.orgId,
    guildId: scope.guildId,
    agentId: scope.agentId,
    viewScope: options.viewScope,
    servers,
    connections,
    listedTools,
  });
}
