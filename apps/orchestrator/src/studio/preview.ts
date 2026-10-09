import {
  agentActor,
  catalogLevels,
  grantsFromBindings,
  type ArtifactStore,
} from "../artifacts/index.js";
import { DEFAULT_ARTIFACT_GRANTS } from "../artifacts/types.js";
import { enabledToolNames, resolvedMcp, resolvedTools } from "../access/index.js";
import { agentSecrets, resolveMcpTool, type AccessDatabase } from "../access/runtime.js";
import { isReadOnlyRemote, listedFromRows, mcpSchema, previewConnectorState } from "../mcp/index.js";
import { collectRunState } from "../state/index.js";
import { guildOperators } from "../guilds/validation.js";
import { memoryOf } from "../agents/validation.js";
import { schemasFor } from "../toolbox/index.js";
import { CONTEXT_HISTORY_LIMIT } from "../groupchat/history.js";
import type { Scripts } from "../scripts/catalog.js";

export type PreviewDeps = {
  db: AccessDatabase & {
    listAgents(guildId: string): Promise<Array<Record<string, unknown>>>;
    listGroupMessages(
      guildId: string,
      options?: { throughSeq?: number | null },
    ): Promise<Array<Record<string, unknown>>>;
    listMcpServers(orgId?: string | null): Promise<Array<Record<string, unknown>>>;
    listMcpConnections(options: {
      orgId?: string | null;
      guildId?: string | null;
      agentId?: string | null;
    }): Promise<Array<Record<string, unknown>>>;
    listMcpTools(connectionId: string): Promise<Array<Record<string, unknown>>>;
  };
  artifacts: ArtifactStore;
  scripts: Scripts;
};

export async function previewCurrentState(
  deps: PreviewDeps,
  agent: Record<string, unknown>,
): Promise<{ state: Record<string, unknown>; projected_at: string }> {
  const projectedAt = new Date().toISOString();
  const orgId = String(agent.org_id);
  const guildId = String(agent.guild_id);
  const agentId = String(agent.id);
  const rows = await deps.db.listBindingsCovering({ orgId, guildId, agentId });
  const grants = grantsFromBindings(rows, { orgId, guildId, agentId });
  const levels = catalogLevels(grants);
  const secrets = await agentSecrets(deps.db, agent);
  const members = (await deps.db.listAgents(guildId)).filter(
    (member) => member.archived_at === null || member.archived_at === undefined,
  );
  const historyRows = await deps.db.listGroupMessages(guildId);
  const actor = agentActor({
    orgId,
    guildId,
    agentId,
    agentName: String(agent.name),
    grants,
  });
  let collections: unknown[] = [];
  try {
    collections = await deps.artifacts.listCollections(actor);
  } catch {
    /* keep empty collections */
  }
  const config = (agent.config && typeof agent.config === "object" ? agent.config : {}) as Record<string, unknown>;
  const state = collectRunState(null, String(agent.org_slug ?? ""), String(agent.guild_name ?? ""), String(agent.name), {
    members,
    operators: guildOperators({ operators: agent.guild_operators }),
    historyRows: historyRows.slice(-CONTEXT_HISTORY_LIMIT),
    guildAbout: String(agent.guild_about || agent.about || ""),
    guildDescription: String(agent.guild_description || agent.description || ""),
    collections,
    secrets,
    scripts: await deps.scripts.catalog(agentId),
    maxToolCalls: Number(config.max_tool_calls ?? 50),
    readableLevels: levels.readable,
    writableLevels: levels.writable,
    connectors: await previewConnectorState(deps.db, agent),
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

function serverSummary(server: Record<string, unknown>): ProjectedConnection["server"] {
  return {
    id: String(server.id),
    slug: String(server.slug),
    display_name: String(server.display_name || server.slug),
  };
}

export async function projectConnection(
  deps: PreviewDeps,
  connection: Record<string, unknown>,
  server: Record<string, unknown>,
): Promise<ProjectedConnection> {
  const slug = String(server.slug);
  const listed = listedFromRows(await deps.db.listMcpTools(String(connection.id)));
  return {
    id: String(connection.id),
    server: serverSummary(server),
    owner_scope: String(connection.owner_scope),
    owner_id: connection.owner_id === null || connection.owner_id === undefined ? null : String(connection.owner_id),
    account_hint: String(connection.account_hint ?? ""),
    status: String(connection.status),
    tools: listed.map((tool) => ({
      name: tool.namespaced_name,
      remote_name: tool.remote_name,
      description: tool.description,
      read_only: isReadOnlyRemote(slug, tool.remote_name, {
        readOnlyHint: tool.read_only_hint,
        verified: server.verified === true,
      }),
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
  const servers = new Map<string, Record<string, unknown>>();
  for (const server of await deps.db.listMcpServers(orgId)) {
    servers.set(String(server.id), server);
  }
  const members = (await deps.db.listAgents(guildId)).filter((row) => !row.archived_at);
  const seen = new Map<string, Record<string, unknown>>();
  const scopes: Array<{ agentId: string | null }> = [{ agentId: null }, ...members.map((row) => ({ agentId: String(row.id) }))];
  for (const scope of scopes) {
    for (const connection of await deps.db.listMcpConnections({ orgId, guildId, agentId: scope.agentId })) {
      seen.set(String(connection.id), connection);
    }
  }
  const projected: ProjectedConnection[] = [];
  for (const connection of seen.values()) {
    const server = servers.get(String(connection.mcp_server_id));
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
  agent: Record<string, unknown>,
): Promise<{
  native_tools: string[];
  scripts: Array<Record<string, unknown>>;
  secrets: Array<{ name: string; description: string }>;
  artifact_levels: { readable: string[]; writable: string[] };
  connections: Array<ProjectedConnection & { server_enabled: boolean; offered_tools: string[] }>;
}> {
  const orgId = String(agent.org_id);
  const guildId = String(agent.guild_id);
  const agentId = String(agent.id);
  const rows = await deps.db.listBindingsCovering({ orgId, guildId, agentId });
  const scope = { orgId, guildId, agentId };
  const nativeTools = enabledToolNames(resolvedTools(rows, scope));
  const secrets = (await agentSecrets(deps.db, agent)).map((row) => ({
    name: row.name ?? "",
    description: row.description ?? "",
  }));
  const levels = catalogLevels(grantsFromBindings(rows, scope));
  const connections = new Map<string, Record<string, unknown>>();
  for (const connection of await deps.db.listMcpConnections(scope)) {
    connections.set(String(connection.id), connection);
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
    artifact_levels: levels,
    connections: projected,
  };
}

export async function projectOfferedToolSchemas(
  deps: PreviewDeps,
  agent: Record<string, unknown>,
): Promise<{
  schemas: Array<Record<string, unknown>>;
  catalog_revision: string | null;
  config_hash: string;
}> {
  const orgId = String(agent.org_id);
  const guildId = String(agent.guild_id);
  const agentId = String(agent.id);
  const rows = await deps.db.listBindingsCovering({ orgId, guildId, agentId });
  const nativeNames = enabledToolNames(resolvedTools(rows, { orgId, guildId, agentId })).filter(
    (name) => memoryOf(agent.config as Record<string, unknown> | undefined) || name !== "memory_write",
  );
  const schemas = [...schemasFor(nativeNames)];
  const servers = await deps.db.listMcpServers(orgId);
  const connections = new Map<string, Record<string, unknown>>();
  let latest: string | null = null;
  for (const connection of await deps.db.listMcpConnections({ orgId, guildId, agentId })) {
    connections.set(String(connection.id), connection);
    const stamp = String(connection.updated_at ?? connection.created_at ?? "");
    if (stamp && (!latest || stamp > latest)) {
      latest = stamp;
    }
  }
  for (const [item] of resolvedMcp(rows, servers, { orgId, guildId, agentId })) {
    if (!item.enabled || item.connection_id === null) {
      continue;
    }
    const connection = connections.get(item.connection_id);
    if (!connection) {
      continue;
    }
    const listed = listedFromRows(await deps.db.listMcpTools(String(connection.id)));
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
      schemas.push(mcpSchema(tool));
    }
  }
  const config = JSON.stringify(agent.config ?? {});
  return {
    schemas,
    catalog_revision: latest,
    config_hash: config,
  };
}

export { DEFAULT_ARTIFACT_GRANTS };
