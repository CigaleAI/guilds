import { accessPayload, mcpToolView, resolvedMcp } from "../access/index.js";
import { resolveMcpTool } from "../access/runtime.js";
import { manifestTools } from "../connectors/load.js";
import { listedFromRows, type McpPool } from "../mcp/index.js";
import type { Repositories } from "../db/repositories.js";

function listedRecord(tool: unknown): Record<string, unknown> {
  if (tool && typeof tool === "object" && !Array.isArray(tool)) {
    return tool as Record<string, unknown>;
  }
  return {};
}

function visibleServers(
  servers: Array<Record<string, unknown>>,
  connections: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const connected = new Set(connections.map((row) => String(row.mcp_server_id)));
  return servers.filter(
    (server) => server.enabled !== false || connected.has(String(server.id)),
  );
}

export async function httpAccess(
  repo: Repositories,
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
  const connections = await repo.listMcpConnections(scope);
  const servers = visibleServers(await repo.listMcpServers(scope.orgId), connections);
  const serversById = new Map(servers.map((server) => [String(server.id), server]));
  const rawListed: Record<string, unknown[]> = {};
  for (const connection of connections) {
    const server = serversById.get(String(connection.mcp_server_id));
    if (server === undefined) {
      continue;
    }
    if (connection.status === "connected" && options.mcp?.syncTools) {
      try {
        rawListed[String(connection.id)] = await options.mcp.syncTools(repo, connection, server);
        continue;
      } catch {
        /* use stored rows */
      }
    }
    rawListed[String(connection.id)] = listedFromRows(await repo.listMcpTools(String(connection.id)));
  }
  // Read after the syncs: a sync writes an Off binding for each tool it lists for the first time.
  const rows = await repo.listBindingsCovering(scope);
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
        const record = listedRecord(tool);
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
