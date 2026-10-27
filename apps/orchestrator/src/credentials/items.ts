import { isoOrNull } from "../db/views.js";
import { jsonObj } from "../db/json.js";
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

export function connectionMetadata(row: Record<string, unknown>): Record<string, unknown> {
  const settings = jsonObj(row.settings);
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
    settings: settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {},
    needs_settings: row.status === "pending" && !row.oauth_state,
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
