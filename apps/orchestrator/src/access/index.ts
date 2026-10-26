import { NATIVE_TOOLS } from "../db/seed/catalog.js";
import { visibleAt } from "../credentials/visibility.js";
import { oauthSetupState } from "../oauth/index.js";
import { connectorFacts } from "../connectors/view.js";
import { awaitingSettings, connectionSettings } from "../connectors/login.js";

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

export class BindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BindingError";
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

export type Resolved = {
  catalog_kind: string;
  catalog_id: string;
  enabled: boolean;
  source_scope: string | null;
  connection_id: string | null;
  overlay: Overlay | null;
};

export function validateScope(
  scope: string,
  scopeId: string | null | undefined,
): [string, string | null] {
  if (!(SCOPES as readonly string[]).includes(scope)) {
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
  if (!(CATALOG_KINDS as readonly string[]).includes(catalogKind)) {
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
    if ((BROWSER_TOOLS as readonly string[]).includes(id)) {
      throw new BindingError(`${id} is not a binding`);
    }
    if (!(NATIVE_TOOLS as readonly string[]).includes(id)) {
      throw new BindingError(`unknown native tool: ${id}`);
    }
  }
  return [catalogKind, id];
}

export function validateBinding(args: {
  catalogKind: string;
  catalogId: string;
  scope: string;
  scopeId: string | null | undefined;
  enabled: boolean;
  guildId?: string | null;
  orgId?: string | null;
  server?: Record<string, unknown> | null;
  connection?: Record<string, unknown> | null;
  connectionId?: string | null;
}): Overlay {
  const [catalogKind, catalogId] = validateCatalog(args.catalogKind, args.catalogId);
  const [scope, scopeId] = validateScope(args.scope, args.scopeId);
  if (catalogKind === "native_tool" || catalogKind === "mcp_tool") {
    return {
      catalog_kind: catalogKind,
      catalog_id: catalogId,
      scope,
      scope_id: scopeId,
      enabled: args.enabled,
      connection_id: null,
    };
  }
  if (catalogKind === "mcp") {
    if (args.server == null) {
      throw new BindingError("unknown mcp server");
    }
    if (args.server.id !== catalogId) {
      throw new BindingError("mcp catalog_id must be the server id");
    }
    if (args.connectionId == null) {
      return {
        catalog_kind: catalogKind,
        catalog_id: catalogId,
        scope,
        scope_id: scopeId,
        enabled: args.enabled,
        connection_id: null,
      };
    }
    if (args.connection == null) {
      throw new BindingError("unknown connection");
    }
    if (args.connection.id !== args.connectionId) {
      throw new BindingError("connection_id must match the connection");
    }
    if (args.connection.mcp_server_id !== catalogId) {
      throw new BindingError("connection is for a different server");
    }
    if (
      !visibleAt(
        String(args.connection.owner_scope),
        (args.connection.owner_id as string | null) ?? null,
        {
          scope,
          scopeId,
          guildId: args.guildId ?? null,
          orgId: args.orgId ?? null,
        },
      )
    ) {
      throw new BindingError("connection is not visible at this scope");
    }
    return {
      catalog_kind: catalogKind,
      catalog_id: catalogId,
      scope,
      scope_id: scopeId,
      enabled: args.enabled,
      connection_id: args.connectionId,
    };
  }
  throw new BindingError("unsupported catalog_kind");
}

function rowOverlay(row: Record<string, unknown>): Overlay {
  return {
    catalog_kind: String(row.catalog_kind),
    catalog_id: String(row.catalog_id),
    scope: String(row.scope),
    scope_id: (row.scope_id as string | null) ?? null,
    enabled: Boolean(row.enabled),
    connection_id: (row.connection_id as string | null) ?? null,
  };
}

export function resolveItem(
  rows: Array<Record<string, unknown>>,
  catalogKind: string,
  catalogId: string,
  options: {
    orgId?: string | null | undefined;
    guildId?: string | null | undefined;
    agentId?: string | null | undefined;
    viewScope?: string | undefined;
  } = {},
): Resolved {
  const viewScope = options.viewScope ?? "agent";
  const chain: Array<[string, string | null]> = [["platform", null]];
  if (options.orgId != null && (viewScope === "org" || viewScope === "guild" || viewScope === "agent")) {
    chain.push(["org", options.orgId]);
  }
  if (options.guildId != null && (viewScope === "guild" || viewScope === "agent")) {
    chain.push(["guild", options.guildId]);
  }
  if (options.agentId != null && viewScope === "agent") {
    chain.push(["agent", options.agentId]);
  }

  let enabled = false;
  let sourceScope: string | null = null;
  let connectionId: string | null = null;
  let overlay: Overlay | null = null;
  const indexed = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (row.catalog_kind === catalogKind && row.catalog_id === catalogId) {
      indexed.set(`${row.scope}\0${row.scope_id}\0${row.catalog_kind}\0${row.catalog_id}`, row);
    }
  }
  for (const [scope, scopeId] of chain) {
    const row = indexed.get(`${scope}\0${scopeId}\0${catalogKind}\0${catalogId}`);
    if (row === undefined) {
      continue;
    }
    const current = rowOverlay(row);
    enabled = current.enabled;
    sourceScope = scope;
    if (current.connection_id !== null) {
      connectionId = current.connection_id;
    }
    if (scope === viewScope) {
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

export function resolvedTools(
  rows: Array<Record<string, unknown>>,
  options: {
    orgId?: string | null | undefined;
    guildId?: string | null | undefined;
    agentId?: string | null | undefined;
    viewScope?: string | undefined;
  } = {},
): Resolved[] {
  return NATIVE_TOOLS.map((name) =>
    resolveItem(rows, "native_tool", name, {
      orgId: options.orgId,
      guildId: options.guildId,
      agentId: options.agentId,
      viewScope: options.viewScope,
    }),
  );
}

export function enabledToolNames(items: Resolved[]): string[] {
  return items.filter((item) => item.enabled).map((item) => item.catalog_id);
}

export function resolvedMcp(
  rows: Array<Record<string, unknown>>,
  servers: Array<Record<string, unknown>>,
  options: {
    orgId?: string | null | undefined;
    guildId?: string | null | undefined;
    agentId?: string | null | undefined;
    viewScope?: string | undefined;
  } = {},
): Array<[Resolved, Record<string, unknown>]> {
  return servers.map((server) => [
    resolveItem(rows, "mcp", String(server.id), {
      orgId: options.orgId,
      guildId: options.guildId,
      agentId: options.agentId,
      viewScope: options.viewScope,
    }),
    server,
  ]);
}

export function toolView(item: Resolved): Record<string, unknown> {
  return {
    name: item.catalog_id,
    enabled: item.enabled,
    source_scope: item.source_scope,
    overlay: item.overlay === null ? null : { enabled: item.overlay.enabled },
  };
}

function inputSchemaOf(value: unknown): Record<string, unknown> {
  let loaded = value;
  if (typeof loaded === "string") {
    try {
      loaded = JSON.parse(loaded);
    } catch {
      return { type: "object" };
    }
  }
  return loaded && typeof loaded === "object" && !Array.isArray(loaded)
    ? (loaded as Record<string, unknown>)
    : { type: "object" };
}

export function mcpToolView(
  item: Resolved,
  listed: { namespaced_name?: unknown; remote_name?: unknown; description?: unknown } | Record<string, unknown>,
  options: { serverSource?: string | null } = {},
): Record<string, unknown> {
  const record = listed as Record<string, unknown>;
  return {
    name: record.namespaced_name ?? record.name,
    remote_name: record.remote_name,
    description: record.description ?? "",
    input_schema: inputSchemaOf(record.input_schema),
    enabled: item.enabled,
    source_scope: item.source_scope || options.serverSource || null,
    overlay: item.overlay === null ? null : { enabled: item.overlay.enabled },
  };
}

export function mcpView(
  item: Resolved,
  server: Record<string, unknown>,
  connection: Record<string, unknown> | null,
  options: { tools?: Array<Record<string, unknown>> | null } = {},
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
    limitations: server.limitations ?? null,
    setup_hint: server.setup_hint ?? null,
    oauth_strategy: server.oauth_strategy ?? null,
    oauth_setup_state: oauthSetupState(server),
    catalog_enabled: server.enabled !== false,
    org_owned: Boolean(server.owner_org_id),
    enabled: item.enabled,
    source_scope: item.source_scope,
    connection_id: item.connection_id,
    status: connection === null ? null : connection.status,
    account_hint: connection === null ? "" : connection.account_hint,
    connection_owner_scope: connection === null ? null : connection.owner_scope,
    overlay,
    tools: options.tools ?? [],
    ...connectorFacts(server),
    settings: connection === null ? {} : connectionSettings(connection),
    needs_settings: connection !== null && awaitingSettings(connection),
  };
  return view;
}

export function accessPayload(args: {
  rows: Array<Record<string, unknown>>;
  orgId?: string | null | undefined;
  guildId?: string | null | undefined;
  agentId?: string | null | undefined;
  viewScope: string;
  servers?: Array<Record<string, unknown>> | null | undefined;
  connections?: Array<Record<string, unknown>> | null | undefined;
  listedTools?: Record<string, unknown[]> | null | undefined;
}): Record<string, unknown> {
  const options = {
    orgId: args.orgId,
    guildId: args.guildId,
    agentId: args.agentId,
    viewScope: args.viewScope,
  };
  const tools = resolvedTools(args.rows, options).map(toolView);
  const byConnection = new Map<string, Record<string, unknown>>();
  for (const connection of args.connections ?? []) {
    byConnection.set(String(connection.id), connection);
  }
  const mcp = resolvedMcp(args.rows, args.servers ?? [], options).map(([item, server]) => {
    const connection =
      item.connection_id !== null ? (byConnection.get(item.connection_id) ?? null) : null;
    const listedKey = item.connection_id !== null ? item.connection_id : `catalog:${server.id}`;
    const listed =
      args.listedTools
        ? ((args.listedTools[listedKey] as Array<Record<string, unknown>> | undefined) ?? [])
        : [];
    return mcpView(item, server, connection, { tools: listed });
  });
  return { tools, mcp };
}
