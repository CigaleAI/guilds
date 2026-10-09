import { formatColumnTimestamp } from "../db/codecs.js";
import { jsonObj } from "../db/json.js";
import { connectorFacts } from "../connectors/view.js";

function iso(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return formatColumnTimestamp(value);
  }
  return value;
}

export function serverItem(row: Record<string, unknown>): Record<string, unknown> {
  const config = jsonObj(row.config) as { url?: unknown } | null;
  return {
    id: row.id,
    slug: row.slug,
    display_name: row.display_name,
    transport: row.transport,
    config: typeof config?.url === "string" ? { url: config.url } : {},
    auth: row.auth,
    description: row.description || "",
    limitations: row.limitations ?? null,
    setup_hint: row.setup_hint ?? null,
    enabled: row.enabled !== false,
    owner_org_id: row.owner_org_id ?? null,
    tool_prefix: row.tool_prefix ?? row.slug,
    oauth_strategy: row.oauth_strategy ?? (row.auth === "oauth" ? "dynamic" : "none"),
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
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    rotated_at: iso(row.rotated_at),
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
