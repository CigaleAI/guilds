import { SCOPES } from "../../src/access/index.js";
import type { LoadedConnector } from "../../src/connectors/servers.js";
import type { BindingRow, NewBinding } from "../../src/db/bindings.js";
import type { ConnectorCallsKey } from "../../src/db/connectors.js";
import type {
  DeletedMcpConnectionRow,
  IdentifiedGithubRepository,
  McpConnectionLogin,
  McpConnectionRow,
  McpToolRow,
  NewMcpTool,
} from "../../src/db/mcp.js";
import type { OAuthClient } from "../../src/db/schema/index.js";
import type { McpDatabase } from "../../src/mcp/database.js";

const STAMP = "2026-10-12T09:00:00.000Z";

/** A tool row of `connectionId` as `replaceMcpTools` stores `tool`, listed at `listedAt`. */
export function storedTool(connectionId: string, tool: NewMcpTool, listedAt: string = STAMP): McpToolRow {
  return {
    id: `tool_${connectionId}_${tool.namespaced_name}`,
    connection_id: connectionId,
    mcp_server_id: "",
    remote_name: tool.remote_name,
    namespaced_name: tool.namespaced_name,
    description: tool.description,
    input_schema: tool.input_schema,
    listed_at: listedAt,
    read_only_hint: tool.read_only_hint ?? null,
    destructive_hint: tool.destructive_hint ?? null,
  };
}

/**
 * The db/ functions MCP reads and writes through, kept in memory: the logins and connectors a test
 * stores, each login's tool listing, the Off overlays a listing writes, the status of each login
 * save, and the calls each organisation makes on a connector a month.
 */
export class MemoryMcpDatabase implements McpDatabase {
  connections: McpConnectionRow[] = [];
  servers: LoadedConnector[] = [];
  tools: McpToolRow[] = [];
  bindings = new Map<string, BindingRow>();
  /** Each login save, as `<connection id>:<status>`. */
  saved: string[] = [];
  deleted: string[] = [];
  repositories: string[] = [];
  calls = new Map<string, number>();

  async getMcpConnection(connectionId: string): Promise<McpConnectionRow | null> {
    return this.connections.find((row) => row.id === connectionId) ?? null;
  }

  async getMcpServer(serverId: string): Promise<LoadedConnector | null> {
    return this.servers.find((row) => row.id === serverId) ?? null;
  }

  async listMcpTools(connectionId: string): Promise<McpToolRow[]> {
    return this.tools.filter((row) => row.connection_id === connectionId);
  }

  async replaceMcpTools(connectionId: string, tools: NewMcpTool[], now: Date): Promise<void> {
    this.tools = [
      ...this.tools.filter((row) => row.connection_id !== connectionId),
      ...tools.map((tool) => storedTool(connectionId, tool, now.toISOString())),
    ];
  }

  async insertBindingIfAbsent(binding: NewBinding, now: Date): Promise<BindingRow> {
    const key = `${binding.catalogKind}:${binding.catalogId}:${binding.scopeId}`;
    const found = this.bindings.get(key);
    if (found) {
      return found;
    }
    const scope = SCOPES.find((name) => name === binding.scope);
    if (binding.catalogKind !== "mcp_tool" || scope === undefined) {
      throw new Error(`the pool writes tool overlays at a scope, not ${key}`);
    }
    const row: BindingRow = {
      id: binding.bindingId,
      catalog_kind: "mcp_tool",
      catalog_id: binding.catalogId,
      scope,
      scope_id: binding.scopeId,
      enabled: binding.enabled,
      connection_id: null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    this.bindings.set(key, row);
    return row;
  }

  async saveMcpConnection(connectionId: string, login: McpConnectionLogin, now: Date): Promise<McpConnectionRow | null> {
    this.saved.push(`${connectionId}:${login.status}`);
    const found = this.connections.find((row) => row.id === connectionId);
    if (!found) {
      return null;
    }
    const saved: McpConnectionRow = {
      ...found,
      ciphertext: login.ciphertext,
      nonce: login.nonce,
      status: login.status,
      account_hint: login.accountHint,
      oauth_state: login.oauthState,
      updated_at: now.toISOString(),
    };
    this.connections = this.connections.map((row) => (row.id === connectionId ? saved : row));
    return saved;
  }

  async deleteMcpConnection(connectionId: string): Promise<DeletedMcpConnectionRow | null> {
    this.deleted.push(connectionId);
    return { id: connectionId };
  }

  async countConnectorCalls(orgId: string, connectorId: string, month: string): Promise<number> {
    return this.calls.get(`${orgId}:${connectorId}:${month}`) ?? 0;
  }

  async recordConnectorCall(calls: ConnectorCallsKey, _now: Date): Promise<void> {
    const key = `${calls.org_id}:${calls.connector_id}:${calls.month}`;
    this.calls.set(key, (this.calls.get(key) ?? 0) + 1);
  }

  async recordGithubRepository(
    connectionId: string,
    repository: IdentifiedGithubRepository,
    _now: Date,
  ): Promise<void> {
    this.repositories.push(`${connectionId}:${repository.name}`);
  }

  async saveOauthClient(serverId: string, _client: OAuthClient, _now: Date): Promise<LoadedConnector | null> {
    throw new Error(`no test registers an OAuth client for ${serverId}`);
  }
}
