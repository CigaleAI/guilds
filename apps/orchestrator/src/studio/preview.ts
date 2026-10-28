import { agentActor, type ArtifactStore } from "../artifacts/index.js";
import { enabledToolNames, resolvedMcp, resolvedTools } from "../access/index.js";
import { accessDatabase, agentLogins, agentSecrets, resolveMcpTool } from "../access/runtime.js";
import { listAgents, type AgentPlaceRow, type AgentRow } from "../db/agents.js";
import { listGroupMessages } from "../db/group-chat.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import { previewConnectorState } from "../mcp/pool.js";
import { collectRunState } from "../state/index.js";
import { guildOperators } from "../guilds/validation.js";
import { memoryOf } from "../agents/validation.js";
import { schemasFor } from "../toolbox/index.js";
import { CONTEXT_HISTORY_LIMIT } from "../groupchat/history.js";
import type { Scripts } from "../scripts/catalog.js";
import type { LoadedConnector } from "../connectors/load.js";
import type { McpConnectionRow } from "../db/mcp.js";
import { listCollections } from "../artifacts/collections.js";

/** The db/ functions a preview of an agent's run state reads, on `db`. */
export function previewDatabase(db: Queryable) {
  return {
    ...accessDatabase(db),
    listAgents: bindQuery(db, listAgents),
    listGroupMessages: bindQuery(db, listGroupMessages),
  };
}

export type PreviewDeps = {
  db: ReturnType<typeof previewDatabase>;
  artifacts: ArtifactStore;
  scripts: Scripts;
};

export async function previewCurrentState(
  deps: PreviewDeps,
  agent: AgentRow,
): Promise<{ state: Record<string, unknown>; projected_at: string }> {
  const projectedAt = new Date().toISOString();
  const orgId = agent.org_id;
  const guildId = agent.guild_id;
  const agentId = agent.id;
  const secrets = await agentSecrets(deps.db, agent);
  const members = await deps.db.listAgents(guildId);
  const historyRows = await deps.db.listGroupMessages(guildId);
  const actor = agentActor({ orgId, guildId, agentId, agentName: agent.name });
  let collections: unknown[] = [];
  try {
    collections = await listCollections(deps.artifacts, actor);
  } catch {
    /* keep empty collections */
  }
  const config = agent.config;
  const state = collectRunState(null, agent.org_slug, agent.guild_name, agent.name, {
    members,
    operators: guildOperators({ operators: agent.guild_operators }),
    historyRows: historyRows.slice(-CONTEXT_HISTORY_LIMIT),
    guildAbout: agent.guild_about,
    guildDescription: agent.guild_description,
    collections,
    secrets,
    scripts: await deps.scripts.catalog(agentId),
    maxToolCalls: Number(config.max_tool_calls ?? 50),
    connectors: previewConnectorState(await agentLogins(deps.db, agent)),
  });
  return { state, projected_at: projectedAt };
}

export type ProjectedConnection = {
  id: string;
  server: { id: string; slug: string; display_name: string };
  owner_scope: string;
  owner_id: string | null;
  account_hint: string;
  status: string;
  tools: Array<{ name: string; remote_name: string; description: string; read_only: boolean }>;
};

function serverSummary(server: LoadedConnector): ProjectedConnection["server"] {
  return {
    id: server.id,
    slug: server.slug,
    display_name: String(server.display_name || server.slug),
  };
}

export async function projectConnection(
  deps: PreviewDeps,
  connection: McpConnectionRow,
  server: LoadedConnector,
): Promise<ProjectedConnection> {
  const listed = await deps.db.connectionTools(connection, server);
  return {
    id: connection.id,
    server: serverSummary(server),
    owner_scope: connection.owner_scope,
    owner_id: connection.owner_id === null || connection.owner_id === undefined ? null : String(connection.owner_id),
    account_hint: String(connection.account_hint ?? ""),
    status: connection.status,
    tools: listed.map((tool) => ({
      name: tool.namespaced_name,
      remote_name: tool.remote_name,
      description: tool.description,
      read_only: tool.read_only,
    })),
  };
}

// Every MCP login an agent of the source guild could inherit: platform, the
// organisation, the guild, and each live member's own logins.
export async function projectGuildConnections(
  deps: PreviewDeps,
  orgId: string,
  guildId: string,
): Promise<ProjectedConnection[]> {
  const servers = new Map<string, LoadedConnector>();
  for (const server of await deps.db.listMcpServers(orgId)) {
    servers.set(server.id, server);
  }
  const members = await deps.db.listAgents(guildId);
  const seen = new Map<string, McpConnectionRow>();
  const scopes: Array<{ agentId: string | null }> = [{ agentId: null }, ...members.map((row) => ({ agentId: String(row.id) }))];
  for (const scope of scopes) {
    for (const connection of await deps.db.listMcpConnections({ orgId, guildId, agentId: scope.agentId })) {
      seen.set(connection.id, connection);
    }
  }
  const projected: ProjectedConnection[] = [];
  for (const connection of seen.values()) {
    const server = servers.get(connection.mcp_server_id);
    if (!server) {
      continue;
    }
    projected.push(await projectConnection(deps, connection, server));
  }
  return projected;
}

// What one agent is offered at run start, projected from bindings and the
// stored MCP catalog: no remote list, no credential decryption.
export async function projectAgentAccess(
  deps: PreviewDeps,
  agent: AgentPlaceRow,
): Promise<{
  native_tools: string[];
  scripts: Array<Record<string, unknown>>;
  secrets: Array<{ name: string; description: string }>;
  connections: Array<ProjectedConnection & { server_enabled: boolean; offered_tools: string[] }>;
}> {
  const orgId = agent.org_id;
  const guildId = agent.guild_id;
  const agentId = agent.id;
  const rows = await deps.db.listBindingsCovering({ orgId, guildId, agentId });
  const scope = { orgId, guildId, agentId };
  const nativeTools = enabledToolNames(resolvedTools(rows, scope));
  const secrets = (await agentSecrets(deps.db, agent)).map((row) => ({
    name: row.name ?? "",
    description: row.description ?? "",
  }));
  const connections = new Map<string, McpConnectionRow>();
  for (const connection of await deps.db.listMcpConnections(scope)) {
    connections.set(connection.id, connection);
  }
  const projected: Array<ProjectedConnection & { server_enabled: boolean; offered_tools: string[] }> = [];
  for (const [item, server] of resolvedMcp(rows, await deps.db.listMcpServers(scope.orgId), scope)) {
    if (item.connection_id === null) {
      continue;
    }
    const connection = connections.get(item.connection_id);
    if (!connection) {
      continue;
    }
    const base = await projectConnection(deps, connection, server);
    const offered = item.enabled && connection.status === "connected"
      ? base.tools
          .filter((tool) => resolveMcpTool(rows, tool.name, { serverEnabled: true, ...scope }).enabled)
          .map((tool) => tool.name)
      : [];
    projected.push({ ...base, server_enabled: item.enabled, offered_tools: offered });
  }
  return {
    native_tools: nativeTools,
    scripts: await deps.scripts.catalog(agentId),
    secrets,
    connections: projected,
  };
}

export async function projectOfferedToolSchemas(
  deps: PreviewDeps,
  agent: Pick<AgentRow, "id" | "guild_id" | "org_id" | "config">,
): Promise<{
  schemas: Array<Record<string, unknown>>;
  catalog_revision: string | null;
  config_hash: string;
}> {
  const orgId = agent.org_id;
  const guildId = agent.guild_id;
  const agentId = agent.id;
  const rows = await deps.db.listBindingsCovering({ orgId, guildId, agentId });
  const nativeNames = enabledToolNames(resolvedTools(rows, { orgId, guildId, agentId })).filter(
    (name) => memoryOf(agent.config as Record<string, unknown> | undefined) || name !== "memory_write",
  );
  const schemas = [...schemasFor(nativeNames)];
  const servers = await deps.db.listMcpServers(orgId);
  const connections = new Map<string, McpConnectionRow>();
  let latest: string | null = null;
  for (const connection of await deps.db.listMcpConnections({ orgId, guildId, agentId })) {
    connections.set(connection.id, connection);
    const stamp = String(connection.updated_at ?? connection.created_at ?? "");
    if (stamp && (!latest || stamp > latest)) {
      latest = stamp;
    }
  }
  for (const [item, server] of resolvedMcp(rows, servers, { orgId, guildId, agentId })) {
    if (!item.enabled || item.connection_id === null) {
      continue;
    }
    const connection = connections.get(item.connection_id);
    if (!connection) {
      continue;
    }
    const listed = await deps.db.connectionTools(connection, server);
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
      schemas.push(tool.schema);
    }
  }
  const config = JSON.stringify(agent.config ?? {});
  return {
    schemas,
    catalog_revision: latest,
    config_hash: config,
  };
}
