import { NATIVE_TOOLS } from "../seed/catalog.js";
import { visibleAt } from "../credentials/visibility.js";
import { oauthSetupState } from "../oauth/index.js";
import { connectorFacts, type LoadedConnector } from "../connectors/servers.js";
import { awaitingSettings } from "../connectors/login.js";
import type { BindingKey, BindingRow, BindingState } from "../db/bindings.js";
import type { McpConnectionRow } from "../db/mcp.js";
import type { ToolInputSchema } from "../db/schema/index.js";

export const NOTE_TOOLS = [
  "note_find",
  "note_get",
  "note_write",
  "note_delete",
  "record_search",
  "record_list",
  "record_add",
  "record_update",
  "record_remove",
  "file_find",
  "file_fetch",
  "file_put",
  "file_delete",
  "memory_write",
] as const;
export const SCRIPT_TOOLS = [
  "script_create",
  "script_list",
  "script_read",
  "script_run",
  "script_delete",
] as const;
export const SCHEDULE_TOOLS = [
  "schedule_create_cron",
  "schedule_create_window",
  "schedule_list",
  "schedule_update",
  "schedule_pause",
  "schedule_resume",
  "schedule_delete",
] as const;
export const BROWSER_TOOLS = [
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_fill",
  "browser_scroll",
  "browser_screenshot",
  "browser_eval",
] as const;
export const ACCESS_NATIVE_TOOLS = NATIVE_TOOLS;
export const CATALOG_KINDS = ["native_tool", "mcp", "mcp_tool"] as const;
export const SCOPES = ["platform", "org", "guild", "agent"] as const;

/** A refused binding request, with the HTTP status it answers with: 422 unless it says otherwise. */
export class BindingError extends Error {
  status: 400 | 404 | 422;

  constructor(message: string, status: 400 | 404 | 422 = 422) {
    super(message);
    this.name = "BindingError";
    this.status = status;
  }
}

export type Overlay = {
  catalog_kind: string;
  catalog_id: string;
  scope: string;
  scope_id: string | null;
  enabled: boolean;
  connection_id: string | null;
};

/** A stored binding, as far as resolving it reads it. */
export type ResolvableBinding = Pick<
  BindingRow,
  "catalog_kind" | "catalog_id" | "scope" | "scope_id" | "enabled" | "connection_id"
>;

/**
 * The scope bindings resolve for: the organisation, guild, and agent whose bindings cover it, and
 * the level it is viewed at, the agent's when left out.
 */
export type ResolutionScope = {
  orgId?: string | null | undefined;
  guildId?: string | null | undefined;
  agentId?: string | null | undefined;
  viewScope?: string | undefined;
};

/** The organisation and guild a binding's scope sits in; null where the scope sits above one. */
export type BindingPlace = {
  orgId: string | null;
  guildId: string | null;
};

/** The connector a binding names and the login it uses; null for a binding of neither. */
export type BoundConnector = {
  server: LoadedConnector | null;
  connection: McpConnectionRow | null;
};

/**
 * The connectors a scope sees, the logins covering it, and each one's listed tools as its view
 * shows them, by login id, or by `catalog:<server id>` for a connector without a login.
 */
export type ScopeConnectors = {
  servers: LoadedConnector[];
  connections: McpConnectionRow[];
  listedTools: Record<string, Array<Record<string, unknown>>>;
};

export type Resolved = {
  catalog_kind: string;
  catalog_id: string;
  enabled: boolean;
  source_scope: string | null;
  connection_id: string | null;
  overlay: Overlay | null;
};

/** Whether `value` is one of `names`. */
function isOneOf<T extends string>(names: readonly T[], value: string): value is T {
  return names.some((name) => name === value);
}

export function validateScope(
  scope: string,
  scopeId: string | null | undefined,
): [string, string | null] {
  if (!isOneOf(SCOPES, scope)) {
    throw new BindingError("scope must be platform, org, guild, or agent");
  }
  if (scope === "platform") {
    if (scopeId !== null && scopeId !== undefined) {
      throw new BindingError("platform bindings must not have scope_id");
    }
    return [scope, null];
  }
  if (!scopeId) {
    throw new BindingError(`${scope} bindings require scope_id`);
  }
  return [scope, scopeId];
}

export function validateCatalog(catalogKind: string, catalogId: string): [string, string] {
  if (!isOneOf(CATALOG_KINDS, catalogKind)) {
    throw new BindingError("catalog_kind must be native_tool, mcp, or mcp_tool");
  }
  if (typeof catalogId !== "string" || !catalogId.trim()) {
    throw new BindingError("catalog_id is required");
  }
  const id = catalogId.trim();
  if (catalogKind === "native_tool") {
    if (id === "report_issue") {
      throw new BindingError(`${id} is not a binding`);
    }
    if (isOneOf(BROWSER_TOOLS, id)) {
      throw new BindingError(`${id} is not a binding`);
    }
    if (!isOneOf(NATIVE_TOOLS, id)) {
      throw new BindingError(`unknown native tool: ${id}`);
    }
  }
  return [catalogKind, id];
}

/**
 * The login a binding of an MCP server uses, checked against the server and login it names and
 * the scope it is set at: null when it names none.
 */
function validateMcpLogin(
  overlay: Overlay,
  connectionId: string | null,
  place: BindingPlace,
  connector: BoundConnector,
): string | null {
  if (connector.server === null) {
    throw new BindingError("unknown mcp server");
  }
  if (connector.server.id !== overlay.catalog_id) {
    throw new BindingError("mcp catalog_id must be the server id");
  }
  if (connectionId === null) {
    return null;
  }
  const connection = connector.connection;
  if (connection === null) {
    throw new BindingError("unknown connection");
  }
  if (connection.id !== connectionId) {
    throw new BindingError("connection_id must match the connection");
  }
  if (connection.mcp_server_id !== overlay.catalog_id) {
    throw new BindingError("connection is for a different server");
  }
  const at = { scope: overlay.scope, scopeId: overlay.scope_id, guildId: place.guildId, orgId: place.orgId };
  if (!visibleAt(connection.owner_scope, connection.owner_id, at)) {
    throw new BindingError("connection is not visible at this scope");
  }
  return connectionId;
}

/**
 * The overlay a binding writes, checked: its catalog item and scope, and for an MCP server the
 * server and login `connector` holds, visible from the scope's `place`.
 */
export function validateBinding(
  key: BindingKey,
  state: BindingState,
  place: BindingPlace,
  connector: BoundConnector,
): Overlay {
  const [catalogKind, catalogId] = validateCatalog(key.catalogKind, key.catalogId);
  const [scope, scopeId] = validateScope(key.scope, key.scopeId);
  const overlay: Overlay = {
    catalog_kind: catalogKind,
    catalog_id: catalogId,
    scope,
    scope_id: scopeId,
    enabled: state.enabled,
    connection_id: null,
  };
  if (catalogKind === "native_tool" || catalogKind === "mcp_tool") {
    return overlay;
  }
  if (catalogKind === "mcp") {
    return { ...overlay, connection_id: validateMcpLogin(overlay, state.connectionId, place, connector) };
  }
  throw new BindingError("unsupported catalog_kind");
}

function rowOverlay(row: ResolvableBinding): Overlay {
  return {
    catalog_kind: row.catalog_kind,
    catalog_id: row.catalog_id,
    scope: row.scope,
    scope_id: row.scope_id,
    enabled: row.enabled,
    connection_id: row.connection_id,
  };
}

/** How many levels each scope sits below the platform. */
const SCOPE_DEPTHS = new Map<string, number>([
  ["platform", 0],
  ["org", 1],
  ["guild", 2],
  ["agent", 3],
]);

/**
 * The scopes whose bindings a view at `scope` inherits, from the platform down to the level it is
 * viewed at; a level `scope` names no id for is left out.
 */
function coveringScopes(scope: ResolutionScope): Array<[string, string | null]> {
  const depth = SCOPE_DEPTHS.get(scope.viewScope ?? "agent") ?? 0;
  const levels: Array<[string, string | null | undefined]> = [
    ["org", scope.orgId],
    ["guild", scope.guildId],
    ["agent", scope.agentId],
  ];
  const chain: Array<[string, string | null]> = [["platform", null]];
  for (const [index, [level, id]] of levels.entries()) {
    if (id != null && index < depth) {
      chain.push([level, id]);
    }
  }
  return chain;
}

export function resolveItem(
  rows: ResolvableBinding[],
  catalogKind: string,
  catalogId: string,
  scope: ResolutionScope = {},
): Resolved {
  const viewScope = scope.viewScope ?? "agent";
  const chain = coveringScopes(scope);
  let enabled = false;
  let sourceScope: string | null = null;
  let connectionId: string | null = null;
  let overlay: Overlay | null = null;
  const indexed = new Map<string, ResolvableBinding>();
  for (const row of rows) {
    if (row.catalog_kind === catalogKind && row.catalog_id === catalogId) {
      indexed.set(`${row.scope}\0${row.scope_id}\0${row.catalog_kind}\0${row.catalog_id}`, row);
    }
  }
  for (const [level, levelId] of chain) {
    const row = indexed.get(`${level}\0${levelId}\0${catalogKind}\0${catalogId}`);
    if (row === undefined) {
      continue;
    }
    const current = rowOverlay(row);
    enabled = current.enabled;
    sourceScope = level;
    if (current.connection_id !== null) {
      connectionId = current.connection_id;
    }
    if (level === viewScope) {
      overlay = current;
    }
  }
  return {
    catalog_kind: catalogKind,
    catalog_id: catalogId,
    enabled,
    source_scope: sourceScope,
    connection_id: connectionId,
    overlay,
  };
}

export function resolvedTools(rows: ResolvableBinding[], scope: ResolutionScope = {}): Resolved[] {
  return NATIVE_TOOLS.map((name) => resolveItem(rows, "native_tool", name, scope));
}

export function enabledToolNames(items: Resolved[]): string[] {
  return items.filter((item) => item.enabled).map((item) => item.catalog_id);
}

export function resolvedMcp(
  rows: ResolvableBinding[],
  servers: LoadedConnector[],
  scope: ResolutionScope = {},
): Array<[Resolved, LoadedConnector]> {
  return servers.map((server) => [resolveItem(rows, "mcp", server.id, scope), server]);
}

export function toolView(item: Resolved): Record<string, unknown> {
  return {
    name: item.catalog_id,
    enabled: item.enabled,
    source_scope: item.source_scope,
    overlay: item.overlay === null ? null : { enabled: item.overlay.enabled },
  };
}

/** A tool as a listing or a manifest names it: what its view shows of it. */
export type ListedToolFields = {
  namespaced_name: string;
  remote_name: string;
  description: string;
  input_schema: ToolInputSchema;
};

/** A listed tool as its view shows it, inheriting its server's source scope when it has none of its own. */
export function mcpToolView(
  item: Resolved,
  listed: ListedToolFields,
  serverSource: string | null,
): Record<string, unknown> {
  return {
    name: listed.namespaced_name,
    remote_name: listed.remote_name,
    description: listed.description,
    input_schema: listed.input_schema,
    enabled: item.enabled,
    source_scope: item.source_scope || serverSource || null,
    overlay: item.overlay === null ? null : { enabled: item.overlay.enabled },
  };
}

export function mcpView(
  item: Resolved,
  server: LoadedConnector,
  connection: McpConnectionRow | null,
  tools: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const overlay =
    item.overlay === null
      ? null
      : {
          enabled: item.overlay.enabled,
          connection_id: item.overlay.connection_id,
        };
  const view: Record<string, unknown> = {
    id: server.id,
    slug: server.slug,
    name: server.display_name,
    auth: server.auth,
    description: server.description || "",
    limitations: server.limitations,
    setup_hint: server.setup_hint,
    oauth_strategy: server.oauth_strategy,
    oauth_setup_state: oauthSetupState(server),
    catalog_enabled: server.enabled,
    org_owned: Boolean(server.owner_org_id),
    enabled: item.enabled,
    source_scope: item.source_scope,
    connection_id: item.connection_id,
    status: connection === null ? null : connection.status,
    account_hint: connection === null ? "" : connection.account_hint,
    connection_owner_scope: connection === null ? null : connection.owner_scope,
    overlay,
    tools,
    ...connectorFacts(server),
    settings: connection === null ? {} : connection.settings,
    needs_settings: connection !== null && awaitingSettings(connection),
  };
  return view;
}

/** The tools and connectors a scope sees, each resolved from `rows` for it. */
export function accessPayload(
  rows: ResolvableBinding[],
  scope: ResolutionScope,
  connectors: ScopeConnectors,
): Record<string, unknown> {
  const tools = resolvedTools(rows, scope).map(toolView);
  const byConnection = new Map<string, McpConnectionRow>();
  for (const connection of connectors.connections) {
    byConnection.set(connection.id, connection);
  }
  const mcp = resolvedMcp(rows, connectors.servers, scope).map(([item, server]) => {
    const connection =
      item.connection_id !== null ? (byConnection.get(item.connection_id) ?? null) : null;
    const listedKey = item.connection_id !== null ? item.connection_id : `catalog:${server.id}`;
    return mcpView(item, server, connection, connectors.listedTools[listedKey] ?? []);
  });
  return { tools, mcp };
}
