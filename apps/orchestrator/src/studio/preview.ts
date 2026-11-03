import { agentActor } from "../artifacts/actors.js";
import { agentTask } from "../artifacts/task.js";
import { ArtifactError } from "../artifacts/errors.js";
import type { ArtifactActor } from "../artifacts/types.js";
import type { ArtifactStore } from "../artifacts/store.js";
import { enabledToolNames, resolvedMcp, resolvedTools } from "../access/index.js";
import { agentLogins, agentSecrets, resolveMcpTool } from "../access/runtime.js";
import { listAgents, type AgentPlaceRow, type AgentRow } from "../db/agents.js";
import { listBindingsCovering } from "../db/bindings.js";
import { listGroupMessages } from "../db/group-chat.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import { previewConnectorState } from "../mcp/pool.js";
import { collectRunState } from "../state/index.js";
import { schemasFor } from "../toolbox/index.js";
import { CONTEXT_HISTORY_LIMIT } from "../groupchat/history.js";
import type { Scripts } from "../scripts/catalog.js";
import { listServers, type LoadedConnector } from "../connectors/servers.js";
import { listMcpConnections, type McpConnectionRow } from "../db/mcp.js";
import { connectionTools } from "../mcp/service.js";
import { collectionCatalog, collectionCatalogShownTo, type CatalogCollection } from "../artifacts/collections.js";
import { promptHash } from "../prompts/index.js";

import type { FunctionTool } from "../lib/tool-schema.js";
import type { ScriptCatalogItem } from "../scripts/catalog.js";

/** The db/ functions an agent's run state preview reads, and its secrets and logins, on `db`. */
export function previewDatabase(db: Queryable) {
  return {
    agentSecrets: bindQuery(db, agentSecrets),
    agentLogins: bindQuery(db, agentLogins),
    listBindingsCovering: bindQuery(db, listBindingsCovering),
    listServers: bindQuery(db, listServers),
    listMcpConnections: bindQuery(db, listMcpConnections),
    connectionTools: bindQuery(db, connectionTools),
    listAgents: bindQuery(db, listAgents),
    listGroupMessages: bindQuery(db, listGroupMessages),
  };
}

export type PreviewDeps = {
  db: ReturnType<typeof previewDatabase>;
  artifacts: ArtifactStore;
  scripts: Scripts;
};

/** The catalog `listing` gives, or none when artifacts refuses to list it, as a run reads it. */
async function catalogOrNone(listing: Promise<CatalogCollection[]>): Promise<CatalogCollection[]> {
  try {
    return await listing;
  } catch (error) {
    if (error instanceof ArtifactError) {
      return [];
    }
    throw error;
  }
}

/** An agent's State as its next run would read it, and when it was projected. */
export type StatePreview = { state: ReturnType<typeof collectRunState>; projected_at: string };

/** The actor an agent's run reads its State as. */
function runActor(agent: AgentRow): ArtifactActor {
  return agentActor({ orgId: agent.org_id, guildId: agent.guild_id, agentId: agent.id, agentName: agent.name });
}

/** An agent's State as its next run would read it, and when it was projected. */
export async function previewCurrentState(deps: PreviewDeps, agent: AgentRow): Promise<StatePreview> {
  return projectState(deps, agent, await catalogOrNone(collectionCatalog(deps.artifacts, runActor(agent))));
}

/**
 * An agent's State as the operator `viewer` is shown it: as its next run would read it, less each
 * table in its catalog that is the own table of a guild hidden from the viewer.
 */
export async function previewStateShownTo(deps: PreviewDeps, viewer: ArtifactActor, agent: AgentRow): Promise<StatePreview> {
  const catalog = collectionCatalogShownTo(deps.artifacts, viewer, runActor(agent));
  return projectState(deps, agent, await catalogOrNone(catalog));
}

/**
 * The hash a run of the agent records as its `task_prompt_hash`: of its Task with the embeds inlined
 * as the agent reads them, or of the Task as written when the store refuses inlining them.
 */
export async function nextRunTaskHash(store: ArtifactStore, agent: AgentRow): Promise<string> {
  const task = await agentTask(store, agent);
  return promptHash(task.expanded.ok ? task.expanded.text : task.text);
}

/** An agent's State as its next run would read it, with `collections` as its catalog, and when it was projected. */
async function projectState(deps: PreviewDeps, agent: AgentRow, collections: CatalogCollection[]): Promise<StatePreview> {
  const projectedAt = new Date().toISOString();
  const guildId = agent.guild_id;
  const agentId = agent.id;
  const secrets = await deps.db.agentSecrets(agent);
  const members = await deps.db.listAgents(guildId);
  const historyRows = await deps.db.listGroupMessages(guildId);
  const config = agent.config;
  const state = collectRunState(null, agent.org_slug, agent.guild_name, agent.name, {
    members,
    operators: agent.guild_operators,
    historyRows: historyRows.slice(-CONTEXT_HISTORY_LIMIT),
    guildAbout: agent.guild_about,
    guildDescription: agent.guild_description,
    collections,
    secrets,
    scripts: await deps.scripts.catalog(agentId),
    maxToolCalls: Number(config.max_tool_calls ?? 50),
    connectors: previewConnectorState(await deps.db.agentLogins(agent)),
  });
  return { state, projected_at: projectedAt };
}

/** A connection's tool as Studio lists it: its namespaced and remote names, what it does, and whether it only reads. */
export type ProjectedTool = { name: string; remote_name: string; description: string; read_only: boolean };

/** A login an agent of the source guild could inherit, with the tools its server lists. */
export type ProjectedConnection = {
  id: string;
  server: { id: string; slug: string; display_name: string };
  owner_scope: McpConnectionRow["owner_scope"];
  owner_id: string | null;
  account_hint: string;
  status: McpConnectionRow["status"];
  tools: ProjectedTool[];
};

/** A connection as one agent is offered it: whether its server is on for the agent, and the tools it is offered. */
export type OfferedConnection = ProjectedConnection & { server_enabled: boolean; offered_tools: string[] };

/** What one agent is offered at run start: native tools, scripts, secret names, and connections. */
export type ProjectedAccess = {
  native_tools: string[];
  scripts: ScriptCatalogItem[];
  secrets: SecretSummary[];
  connections: OfferedConnection[];
};

/** A secret an agent can read, by its name and what it is for. */
export type SecretSummary = { name: string; description: string };

/**
 * The function schemas one agent is offered at run start, natives and connection tools; the
 * newest connection change; and the agent's configuration as text, which a publish compares.
 */
export type OfferedToolSchemas = {
  schemas: FunctionTool[];
  catalog_revision: string | null;
  config_hash: string;
};

function serverSummary(server: LoadedConnector): ProjectedConnection["server"] {
  return {
    id: server.id,
    slug: server.slug,
    display_name: server.display_name || server.slug,
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
    owner_id: connection.owner_id,
    account_hint: connection.account_hint,
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
  for (const server of await deps.db.listServers({ owner: { visibleTo: orgId } })) {
    servers.set(server.id, server);
  }
  const members = await deps.db.listAgents(guildId);
  const seen = new Map<string, McpConnectionRow>();
  const scopes: Array<{ agentId: string | null }> = [{ agentId: null }, ...members.map((row) => ({ agentId: row.id }))];
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
export async function projectAgentAccess(deps: PreviewDeps, agent: AgentPlaceRow): Promise<ProjectedAccess> {
  const orgId = agent.org_id;
  const guildId = agent.guild_id;
  const agentId = agent.id;
  const rows = await deps.db.listBindingsCovering({ orgId, guildId, agentId });
  const scope = { orgId, guildId, agentId };
  const nativeTools = enabledToolNames(resolvedTools(rows, scope));
  const secrets = (await deps.db.agentSecrets(agent)).map((row) => ({
    name: row.name ?? "",
    description: row.description ?? "",
  }));
  const connections = new Map<string, McpConnectionRow>();
  for (const connection of await deps.db.listMcpConnections(scope)) {
    connections.set(connection.id, connection);
  }
  const projected: OfferedConnection[] = [];
  for (const [item, server] of resolvedMcp(rows, await deps.db.listServers({ owner: { visibleTo: scope.orgId } }), scope)) {
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
          .filter((tool) => resolveMcpTool(rows, tool.name, scope, true).enabled)
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
): Promise<OfferedToolSchemas> {
  const orgId = agent.org_id;
  const guildId = agent.guild_id;
  const agentId = agent.id;
  const rows = await deps.db.listBindingsCovering({ orgId, guildId, agentId });
  const nativeNames = enabledToolNames(resolvedTools(rows, { orgId, guildId, agentId })).filter(
    (name) => agent.config.memory || name !== "memory_write",
  );
  const schemas = [...schemasFor(nativeNames)];
  const servers = await deps.db.listServers({ owner: { visibleTo: orgId } });
  const connections = new Map<string, McpConnectionRow>();
  let latest: string | null = null;
  for (const connection of await deps.db.listMcpConnections({ orgId, guildId, agentId })) {
    connections.set(connection.id, connection);
    if (!latest || connection.updated_at > latest) {
      latest = connection.updated_at;
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
      const resolved = resolveMcpTool(rows, tool.namespaced_name, { orgId, guildId, agentId }, true);
      if (!resolved.enabled) {
        continue;
      }
      schemas.push(tool.schema);
    }
  }
  const config = JSON.stringify(agent.config);
  return {
    schemas,
    catalog_revision: latest,
    config_hash: config,
  };
}
