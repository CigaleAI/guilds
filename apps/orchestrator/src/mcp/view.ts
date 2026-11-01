import { isoOrNull } from "../db/views.js";
import type { BindingRow } from "../db/bindings.js";
import type { McpConnectionRow } from "../db/mcp.js";
import type { ConnectionSettings } from "../db/schema/index.js";
import { awaitingSettings } from "../connectors/login.js";
import { connectorFacts, type ConnectorFacts, type LoadedConnector } from "../connectors/servers.js";

/** A connector as an organisation's members see it: its copy, its endpoint, how it signs in, and its facts. */
export type ServerView = Pick<
  LoadedConnector,
  | "id"
  | "slug"
  | "display_name"
  | "transport"
  | "auth"
  | "description"
  | "limitations"
  | "setup_hint"
  | "enabled"
  | "owner_org_id"
  | "tool_prefix"
  | "oauth_strategy"
> &
  ConnectorFacts & { config: Pick<LoadedConnector["config"], "url"> };

export function serverItem(row: LoadedConnector): ServerView {
  return {
    id: row.id,
    slug: row.slug,
    display_name: row.display_name,
    transport: row.transport,
    config: row.config.url === undefined ? {} : { url: row.config.url },
    auth: row.auth,
    description: row.description,
    limitations: row.limitations,
    setup_hint: row.setup_hint,
    enabled: row.enabled,
    owner_org_id: row.owner_org_id,
    tool_prefix: row.tool_prefix,
    oauth_strategy: row.oauth_strategy,
    ...connectorFacts(row),
  };
}

/** A login as the API shows it: its owner, its state, and its settings, without its credentials. */
export type ConnectionView = {
  id: string;
  mcp_server_id: string;
  owner_scope: McpConnectionRow["owner_scope"];
  owner_id: string | null;
  account_hint: string;
  status: McpConnectionRow["status"];
  created_at: string | null;
  updated_at: string | null;
  rotated_at: string | null;
  settings: ConnectionSettings;
  needs_settings: boolean;
};

export function connectionMetadata(row: McpConnectionRow): ConnectionView {
  return {
    id: row.id,
    mcp_server_id: row.mcp_server_id,
    owner_scope: row.owner_scope,
    owner_id: row.owner_id,
    account_hint: row.account_hint,
    status: row.status,
    created_at: isoOrNull(row.created_at),
    updated_at: isoOrNull(row.updated_at),
    rotated_at: isoOrNull(row.rotated_at),
    settings: row.settings,
    needs_settings: awaitingSettings(row),
  };
}

/** A binding as the API shows it: what it turns on or off, where, and the login a connector's binding uses. */
export type BindingView = Pick<BindingRow, "id" | "catalog_kind" | "catalog_id" | "scope" | "scope_id" | "enabled" | "connection_id">;

export function bindingItem(row: BindingRow): BindingView {
  return {
    id: row.id,
    catalog_kind: row.catalog_kind,
    catalog_id: row.catalog_id,
    scope: row.scope,
    scope_id: row.scope_id,
    enabled: row.enabled,
    connection_id: row.connection_id,
  };
}
