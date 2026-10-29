import { accessPayload, mcpToolView, resolvedMcp } from "./index.js";
import { agentSecrets, resolveMcpTool } from "./runtime.js";
import { agentDetail } from "../agents/view.js";
import { listServers, serverTools, type LoadedConnector } from "../connectors/servers.js";
import type { AgentRow } from "../db/agents.js";
import { listBindingsCovering } from "../db/bindings.js";
import { listMcpConnections, type McpConnectionRow } from "../db/mcp.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import type { McpPool } from "../mcp/pool.js";
import { connectionTools, currentTools, type ConnectionTool } from "../mcp/service.js";

/** The pool a view lists its connections' tools through. */
type ToolListing = Pick<McpPool, "syncTools" | "database">;

/** The db/ functions a scope's access view reads, and the stored tool listings it shows, on `db`. */
export function accessViewDatabase(db: Queryable) {
  return {
    listBindingsCovering: bindQuery(db, listBindingsCovering),
    listServers: bindQuery(db, listServers),
    listMcpConnections: bindQuery(db, listMcpConnections),
    connectionTools: bindQuery(db, connectionTools),
  };
}

export type AccessViewDatabase = ReturnType<typeof accessViewDatabase>;

function visibleServers(
  servers: LoadedConnector[],
  connections: McpConnectionRow[],
): LoadedConnector[] {
  const connected = new Set(connections.map((row) => String(row.mcp_server_id)));
  return servers.filter((server) => server.enabled || connected.has(server.id));
}

/**
 * Each connection's listed tools, by connection id: as the pool lists them now when there is one,
 * else as last stored. A connection whose server the scope does not see is left out.
 */
async function listConnectionTools(
  db: AccessViewDatabase,
  mcp: ToolListing | null,
  connections: McpConnectionRow[],
  servers: LoadedConnector[],
): Promise<Record<string, ConnectionTool[]>> {
  const serversById = new Map(servers.map((server) => [server.id, server]));
  const rawListed: Record<string, ConnectionTool[]> = {};
  for (const connection of connections) {
    const server = serversById.get(connection.mcp_server_id);
    if (server !== undefined) {
      rawListed[connection.id] = mcp === null
        ? await db.connectionTools(connection, server)
        : await currentTools(mcp, connection, server);
    }
  }
  return rawListed;
}

/**
 * The scope an access view is of, the level it is shown at, and the pool its tools are listed
 * through.
 */
type AccessViewOptions = {
  orgId?: string | null;
  guildId?: string | null;
  agentId?: string | null;
  viewScope: string;
  mcp?: ToolListing | null;
};

/**
 * The tools, connectors and bindings a scope sees, with each listed tool resolved for it, read
 * through `db`, the dependencies object a unit test fakes.
 */
export async function loadAccessViewThrough(
  db: AccessViewDatabase,
  options: AccessViewOptions,
): Promise<Record<string, unknown>> {
  const scope = {
    orgId: options.orgId ?? null,
    guildId: options.guildId ?? null,
    agentId: options.agentId ?? null,
  };
  const connections = await db.listMcpConnections(scope);
  const servers = visibleServers(await db.listServers({ owner: { visibleTo: scope.orgId } }), connections);
  const rawListed = await listConnectionTools(db, options.mcp ?? null, connections, servers);
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
        const resolved = resolveMcpTool(rows, tool.namespaced_name, {
          serverEnabled: item.enabled,
          orgId: scope.orgId,
          guildId: scope.guildId,
          agentId: scope.agentId,
          viewScope: options.viewScope,
        });
        return mcpToolView(resolved, tool, { serverSource: item.source_scope });
      });
      continue;
    }
    listedTools[key] = serverTools(server).map((tool) => {
      const namespaced = tool.namespaced_name;
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

/** The tools, connectors and bindings a scope sees, with each listed tool resolved for it. */
export async function loadAccessView(
  db: Queryable,
  options: AccessViewOptions,
): Promise<Record<string, unknown>> {
  return loadAccessViewThrough(accessViewDatabase(db), options);
}

/** An agent as its page shows it: its settings, whether it is generating, and its access with the secrets it reaches. */
export async function loadAgentView(
  db: Queryable,
  mcp: McpPool | null,
  row: AgentRow,
  generating: boolean,
): Promise<Record<string, unknown>> {
  const access = await loadAccessView(db, {
    orgId: row.org_id,
    guildId: row.guild_id,
    agentId: row.id,
    viewScope: "agent",
    mcp,
  });
  return {
    ...agentDetail(row, generating),
    access: { ...access, secrets: await agentSecrets(db, row) },
  };
}
