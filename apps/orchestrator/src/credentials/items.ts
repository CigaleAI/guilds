import { isoOrNull } from "../db/views.js";
import type { McpConnectionRow } from "../db/mcp.js";
import type { ConnectionSettings } from "../db/schema/index.js";
import { awaitingSettings } from "../connectors/login.js";
import type { LoadedConnector } from "../connectors/load.js";
import { connectorFacts } from "../connectors/view.js";

export function serverItem(row: LoadedConnector): Record<string, unknown> {
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

export function bindingItem(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    catalog_kind: row.catalog_kind,
    catalog_id: row.catalog_id,
    scope: row.scope,
    scope_id: row.scope_id,
    enabled: Boolean(row.enabled),
    connection_id: row.connection_id ?? null,
  };
}
