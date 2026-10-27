import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACCESS_NATIVE_TOOLS,
  BindingError,
  accessPayload,
  enabledToolNames,
  mcpToolView,
  resolveItem,
  resolvedTools,
  validateBinding,
  validateCatalog,
  validateScope,
} from "../../src/access/index.js";
import { visibleAt } from "../../src/credentials/visibility.js";
import { loadJsonFixture } from "../helpers/fixtures.js";
import { serverRow } from "../helpers/servers.js";
import type { LoadedConnector } from "../../src/connectors/load.js";

const fixture = loadJsonFixture<{
  inherited: Record<string, unknown>;
  agent_opt_out: Record<string, unknown>;
  guild_opt_out_reenabled: Record<string, unknown>;
  org_overlay: Record<string, unknown>;
  empty_chain: Record<string, unknown>;
  enabled_names: string[];
  native_tools: string[];
  visibility: { platform_on_agent: boolean; org_cross_tenant: boolean };
}>("bindings/resolution.json");

function binding(
  kind: string,
  catalogId: string,
  scope: string,
  scopeId: string | null,
  enabled: boolean,
  connectionId: string | null = null,
): Record<string, unknown> {
  return {
    catalog_kind: kind,
    catalog_id: catalogId,
    scope,
    scope_id: scopeId,
    enabled,
    connection_id: connectionId,
  };
}

function server(serverId = "mcp_notion", slug = "notion"): LoadedConnector {
  return serverRow(slug, { id: serverId, display_name: slug[0]?.toUpperCase() + slug.slice(1), auth: "oauth" });
}

function connection(
  connId: string,
  options: {
    serverId?: string;
    ownerScope?: string;
    ownerId?: string | null;
    status?: string;
    accountHint?: string;
  } = {},
): Record<string, unknown> {
  return {
    id: connId,
    mcp_server_id: options.serverId ?? "mcp_notion",
    owner_scope: options.ownerScope ?? "guild",
    owner_id: options.ownerId === undefined ? "pd" : options.ownerId,
    account_hint: options.accountHint ?? "",
    status: options.status ?? "pending",
  };
}

test("native tool order matches the R0 fixture", () => {
  assert.deepEqual([...ACCESS_NATIVE_TOOLS], fixture.native_tools);
});

test("platform tool is inherited until opt-out", () => {
  const rows = [binding("native_tool", "bash", "platform", null, true)];
  const inherited = resolveItem(rows, "native_tool", "bash", { guildId: "pd", agentId: "a" });
  assert.deepEqual(inherited, fixture.inherited);
  const opted = resolveItem(
    [...rows, binding("native_tool", "bash", "agent", "a", false)],
    "native_tool",
    "bash",
    { guildId: "pd", agentId: "a" },
  );
  assert.deepEqual(opted, fixture.agent_opt_out);
});

test("guild opt-out can be reenabled", () => {
  const rows = [
    binding("native_tool", "note_read", "platform", null, true),
    binding("native_tool", "note_read", "guild", "pd", false),
    binding("native_tool", "note_read", "agent", "a", true),
  ];
  const item = resolveItem(rows, "native_tool", "note_read", { guildId: "pd", agentId: "a" });
  assert.deepEqual(item, fixture.guild_opt_out_reenabled);
  const guild = resolveItem(rows, "native_tool", "note_read", { guildId: "pd", viewScope: "guild" });
  assert.equal(guild.enabled, false);
  assert.equal(guild.source_scope, "guild");
});

test("org overlay sits between platform and guild", () => {
  const rows = [
    binding("native_tool", "bash", "platform", null, true),
    binding("native_tool", "bash", "org", "o1", false),
  ];
  const inherited = resolveItem(rows, "native_tool", "bash", {
    orgId: "o1",
    guildId: "pd",
    agentId: "a",
  });
  assert.deepEqual(inherited, fixture.org_overlay);
  const reenabled = resolveItem(
    [...rows, binding("native_tool", "bash", "guild", "pd", true)],
    "native_tool",
    "bash",
    { orgId: "o1", guildId: "pd", agentId: "a" },
  );
  assert.equal(reenabled.enabled, true);
  assert.equal(reenabled.source_scope, "guild");
});

test("empty chain is disabled", () => {
  const item = resolveItem([], "native_tool", "bash", { guildId: "pd", agentId: "a" });
  assert.deepEqual(item, fixture.empty_chain);
});

test("enabled_tool_names skip disabled", () => {
  const rows = [
    binding("native_tool", "script_run", "platform", null, true),
    binding("native_tool", "note_list", "platform", null, true),
    binding("native_tool", "note_list", "agent", "a", false),
  ];
  const names = enabledToolNames(resolvedTools(rows, { guildId: "pd", agentId: "a" }));
  assert.deepEqual(names, fixture.enabled_names);
});

test("credential visibility", () => {
  assert.equal(visibleAt("platform", null, { scope: "agent", scopeId: "a", guildId: "pd" }), true);
  assert.equal(visibleAt("org", "o1", { scope: "org", scopeId: "o1" }), true);
  assert.equal(
    visibleAt("org", "o1", { scope: "agent", scopeId: "a", guildId: "pd", orgId: "o1" }),
    true,
  );
  assert.equal(
    visibleAt("org", "o1", { scope: "agent", scopeId: "a", guildId: "pd", orgId: "o2" }),
    false,
  );
  assert.equal(visibleAt("guild", "pd", { scope: "agent", scopeId: "a", guildId: "pd" }), true);
  assert.equal(visibleAt("agent", "a", { scope: "agent", scopeId: "a", guildId: "pd" }), true);
  assert.equal(visibleAt("guild", "other", { scope: "agent", scopeId: "a", guildId: "pd" }), false);
  assert.equal(visibleAt("agent", "a", { scope: "guild", scopeId: "pd" }), false);
  assert.equal(fixture.visibility.platform_on_agent, true);
  assert.equal(fixture.visibility.org_cross_tenant, false);
});

test("secrets are not a binding kind", () => {
  assert.throws(() => validateCatalog("secret", "sec_1"), /catalog_kind must be/);
});

test("mcp binding requires a catalog server", () => {
  assert.throws(
    () =>
      validateBinding({
        catalogKind: "mcp",
        catalogId: "mcp_notion",
        scope: "guild",
        scopeId: "pd",
        enabled: true,
      }),
    /unknown mcp server/,
  );
});

test("mcp binding accepts a visible connection", () => {
  const overlay = validateBinding({
    catalogKind: "mcp",
    catalogId: "mcp_notion",
    scope: "guild",
    scopeId: "pd",
    enabled: true,
    server: server(),
    connection: connection("conn_1"),
    connectionId: "conn_1",
    guildId: "pd",
  });
  assert.equal(overlay.connection_id, "conn_1");
  assert.equal(overlay.enabled, true);
});

test("mcp connection visibility", () => {
  const agentConn = connection("conn_a", { ownerScope: "agent", ownerId: "a" });
  assert.throws(
    () =>
      validateBinding({
        catalogKind: "mcp",
        catalogId: "mcp_notion",
        scope: "guild",
        scopeId: "pd",
        enabled: true,
        server: server(),
        connection: agentConn,
        connectionId: "conn_a",
        guildId: "pd",
      }),
    /not visible/,
  );
});

test("validate_scope rejects unknown values", () => {
  assert.throws(() => validateScope("room", null), BindingError);
});

test("mcp_tool_view includes the listed input schema", () => {
  const view = mcpToolView(
    {
      catalog_kind: "mcp_tool",
      catalog_id: "coingecko_search",
      enabled: true,
      source_scope: "guild",
      connection_id: "conn_p",
      overlay: null,
    },
    {
      namespaced_name: "coingecko_search",
      remote_name: "search",
      description: "Find",
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  );
  assert.equal(view.name, "coingecko_search");
  assert.deepEqual(view.input_schema, {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  });
});

test("access_payload lists catalog and connection status", () => {
  const payload = accessPayload({
    rows: [binding("mcp", "mcp_notion", "guild", "pd", true, "conn_p")],
    guildId: "pd",
    agentId: "a",
    viewScope: "agent",
    servers: [server(), server("mcp_gmail", "gmail")],
    connections: [connection("conn_p")],
  });
  const byId = Object.fromEntries(
    (payload.mcp as Array<Record<string, unknown>>).map((item) => [item.id, item]),
  );
  const notion = byId.mcp_notion as Record<string, unknown>;
  assert.equal(notion.name, "Notion");
  assert.equal(notion.enabled, true);
  assert.equal(notion.source_scope, "guild");
  assert.equal(notion.status, "pending");
  assert.equal(notion.connection_id, "conn_p");
  assert.equal(notion.overlay, null);
  const gmail = byId.mcp_gmail as Record<string, unknown>;
  assert.equal(gmail.enabled, false);
  assert.equal(gmail.status, null);
  assert.equal(gmail.connection_id, null);
});

test("pending oauth without a binding is not enabled", () => {
  const payload = accessPayload({
    rows: [],
    orgId: "o1",
    viewScope: "org",
    servers: [server("mcp_gmail", "gmail")],
    connections: [connection("conn_g", { serverId: "mcp_gmail", ownerScope: "org", ownerId: "o1" })],
  });
  const gmail = (payload.mcp as Array<Record<string, unknown>>)[0];
  assert.equal(gmail?.enabled, false);
  assert.equal(gmail?.status, null);
  assert.equal(gmail?.connection_id, null);
});
