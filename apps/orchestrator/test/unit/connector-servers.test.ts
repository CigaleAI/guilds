import assert from "node:assert/strict";
import { test } from "node:test";
import { CONNECTORS } from "../../src/connectors/index.js";
import {
  connectorCode,
  editableTools,
  editCopyOverrides,
  effectiveTool,
  holdsRequiredSettings,
  installedConnectorBySlug,
  installedManifests,
  isReadOnlyRemote,
  listedTool,
  listServers,
  logoPath,
  overriddenCopyFields,
  serverManifest,
  serverSettings,
  serverTools,
  settingsOutcome,
  stateHooks,
  tokenFields,
} from "../../src/connectors/servers.js";
import { SettingsError } from "../../src/connectors/settings.js";
import type { ConnectorRow } from "../../src/db/connectors.js";
import type { Queryable } from "../../src/db/pg.js";
import type { Manifest } from "../../src/db/schema/index.js";
import { restoreConnectorsAfterEach, runConnectors } from "../helpers/installed.js";
import { WITH_QUOTES } from "../helpers/quotes.js";
import { serverRow } from "../helpers/servers.js";

restoreConnectorsAfterEach();

const STAMP = "2026-10-12T09:00:00.000Z";

function connectorRow(slug: string, fields: Partial<ConnectorRow> = {}): ConnectorRow {
  const manifest: Manifest = { slug, display_name: slug, auth: { kind: "token" }, description: "" };
  return {
    id: `mcp_${slug}`,
    slug,
    tool_prefix: slug,
    owner_org_id: null,
    manifest,
    source: "local",
    version: "",
    verified: false,
    experimental: false,
    publisher: "",
    enabled: true,
    oauth_client: null,
    overrides: {},
    installed_at: STAMP,
    updated_at: STAMP,
    ...fields,
  };
}

const ROWS: ConnectorRow[] = [
  connectorRow("notion", { source: "core" }),
  connectorRow("acme", { source: "registry" }),
  connectorRow("dormant", { enabled: false }),
  connectorRow("crm", { owner_org_id: "org_1" }),
  connectorRow("wiki", { owner_org_id: "org_2" }),
];

/** A database holding `ROWS`, answering `listOrgConnectors` the way its query does: the platform's rows and the named organisation's. */
const db = {
  query: async (_text: string, params: unknown[]) => ({
    rows: ROWS.filter((row) => row.owner_org_id === null || row.owner_org_id === params[0]),
  }),
} as unknown as Queryable;

async function slugs(scope: Parameters<typeof listServers>[1]): Promise<string[]> {
  return (await listServers(db, scope)).map((server) => server.slug);
}

test("lists_platform_servers_only_when_scope_is_platform", async () => {
  assert.deepEqual(await slugs({ owner: "platform" }), ["notion", "acme", "dormant"]);
});

test("lists_an_organisations_own_servers_only_when_scope_names_its_id", async () => {
  assert.deepEqual(await slugs({ owner: { orgId: "org_1" } }), ["crm"]);
});

test("lists_the_platforms_servers_and_an_organisations_own_when_scope_is_what_it_sees", async () => {
  assert.deepEqual(await slugs({ owner: { visibleTo: "org_1" } }), ["notion", "acme", "dormant", "crm"]);
  assert.deepEqual(await slugs({ owner: { visibleTo: null } }), ["notion", "acme", "dormant"]);
});

test("keeps_switched_on_servers_only_when_scope_asks_for_enabled", async () => {
  assert.deepEqual(await slugs({ owner: { visibleTo: "org_1" }, enabled: true }), ["notion", "acme", "crm"]);
});

test("keeps_registry_servers_only_when_scope_asks_for_that_source", async () => {
  assert.deepEqual(await slugs({ owner: "platform", source: "registry" }), ["acme"]);
});

test("editable_tools_list_the_manifests_tools_by_name_then_the_ones_only_overrides_name", () => {
  const gmail = serverRow("gmail", {
    overrides: { tools: { search_threads: { default: false }, extra_search: { description: "Added.", default: true } } },
  });
  const tools = editableTools(gmail);
  assert.deepEqual(serverTools(gmail), tools.slice(0, -1));
  const names = tools.map((tool) => tool.namespaced_name);
  const manifestNames = names.slice(0, -1);
  assert.deepEqual(manifestNames, [...manifestNames].sort((left, right) => left.localeCompare(right)));
  const search = tools.find((tool) => tool.remote_name === "search_threads")!;
  assert.equal(search.default_enabled, false);
  assert.equal(search.default_override, false);
  assert.equal(search.overridden, true);
  assert.deepEqual(tools.at(-1), {
    remote_name: "extra_search",
    namespaced_name: "gmail_extra_search",
    description: "Added.",
    input_schema: { type: "object" },
    mutating: false,
    default_enabled: true,
    default_override: true,
    overridden: true,
  });
  const fetch = tools.find((tool) => tool.remote_name === "get_thread")!;
  assert.equal(fetch.overridden, false);
  assert.equal(fetch.default_override, null);
});

test("effective_tool_is_null_for_a_tool_the_manifest_excludes", () => {
  const server = serverRow("acme", { manifest: { ...serverRow("acme").manifest, policy: { exclude: ["admin_*"] } } });
  assert.equal(effectiveTool(server, { name: "admin_reset", description: "", input_schema: { type: "object" } }), null);
  assert.notEqual(effectiveTool(server, { name: "list_orders", description: "", input_schema: { type: "object" } }), null);
});

test("effective_tool_applies_the_admins_edits_and_keeps_the_listings_hints", () => {
  const server = serverRow("acme", {
    tool_prefix: "ac",
    overrides: { tools: { list_orders: { description: "Orders.", input_schema: { type: "object", properties: {} }, default: false } } },
  });
  assert.deepEqual(
    effectiveTool(server, {
      name: "list_orders",
      description: "Lists.",
      input_schema: { type: "object" },
      read_only_hint: true,
      destructive_hint: false,
    }),
    {
      remote_name: "list_orders",
      namespaced_name: "ac_list_orders",
      description: "Orders.",
      input_schema: { type: "object", properties: {} },
      mutating: false,
      read_only_hint: true,
      destructive_hint: false,
      default_enabled: false,
      default_override: false,
      overridden: true,
    },
  );
  const plain = effectiveTool(server, { name: "delete_orders", description: "Drops.", input_schema: { type: "object" }, mutating: true });
  assert.equal(plain?.description, "Drops.");
  assert.equal(plain?.mutating, true);
  assert.equal(plain?.default_enabled, false);
  assert.equal(plain?.overridden, false);
  assert.equal(plain?.read_only_hint, null);
});

test("server_manifest_is_the_running_connectors_before_the_rows", () => {
  const edited = serverRow("notion", { manifest: { ...serverRow("notion").manifest, auth: { kind: "token" } } });
  assert.equal(serverManifest(edited), CONNECTORS.bySlug("notion")!.manifest);
});

test("listed_tool_keeps_its_stored_names_and_applies_the_admins_edit", () => {
  const server = serverRow("acme", { overrides: { tools: { list_orders: { description: "Orders.", default: false } } } });
  const row = {
    id: "tool_1",
    connection_id: "conn_1",
    mcp_server_id: "mcp_acme",
    remote_name: "list_orders",
    namespaced_name: "stored_list_orders",
    description: "Lists.",
    input_schema: { type: "object" as const },
    listed_at: STAMP,
    read_only_hint: null,
    destructive_hint: null,
  };
  assert.deepEqual(listedTool(server, row), {
    remote_name: "list_orders",
    namespaced_name: "stored_list_orders",
    description: "Orders.",
    input_schema: { type: "object" },
    mutating: false,
    default_enabled: false,
    default_override: false,
    overridden: true,
  });
  const plain = listedTool(serverRow("acme"), { ...row, remote_name: "drop_all", destructive_hint: true });
  assert.equal(plain.description, "Lists.");
  assert.equal(plain.default_enabled, false);
  assert.equal(plain.overridden, false);
});

test("is_read_only_remote_reads_the_running_connector_under_the_servers_slug", () => {
  const custom = serverRow("custom", { manifest: { ...serverRow("custom").manifest, policy: { default_off: ["search"] } } });
  assert.equal(isReadOnlyRemote(custom, "search", null), true, "a row's own manifest is not read");
  assert.equal(isReadOnlyRemote(serverRow("drive"), "create_file", null), false);
  assert.equal(isReadOnlyRemote(serverRow("gmail"), "get_thread", null), true);
});

test("server_settings_are_the_running_connectors_schema_or_null", () => {
  assert.equal(serverSettings(serverRow("quotes")), null);
  runConnectors(WITH_QUOTES);
  assert.deepEqual((serverSettings(serverRow("quotes")) as { required: string[] }).required, ["symbols"]);
});

test("holds_required_settings_when_the_schema_requires_nothing_or_they_hold_it", () => {
  runConnectors(WITH_QUOTES);
  const quotes = serverRow("quotes");
  assert.equal(holdsRequiredSettings(quotes, {}), false);
  assert.equal(holdsRequiredSettings(quotes, { symbols: "unchecked" }), true);
  assert.equal(holdsRequiredSettings(serverRow("acme"), {}), true);
});

test("settings_outcome_takes_the_values_as_they_are_when_the_server_has_no_schema", () => {
  assert.deepEqual(settingsOutcome(serverRow("acme"), { anything: 1 }), { kind: "complete", values: { anything: 1 } });
});

test("settings_outcome_checks_given_settings_in_full_and_is_complete_with_them", () => {
  runConnectors(WITH_QUOTES);
  const quotes = serverRow("quotes");
  assert.deepEqual(settingsOutcome(quotes, { symbols: [{ id: "btc" }] }), { kind: "complete", values: { symbols: [{ id: "btc" }] } });
  assert.throws(() => settingsOutcome(quotes, { symbols: "btc" }), SettingsError);
  assert.throws(() => settingsOutcome(quotes, { other: true }), SettingsError);
});

test("settings_outcome_awaits_settings_when_none_are_given_and_the_schema_requires_some", () => {
  runConnectors(WITH_QUOTES);
  assert.deepEqual(settingsOutcome(serverRow("quotes"), {}), { kind: "awaiting", values: {} });
});

test("token_fields_are_the_running_connectors_else_one_token_field", () => {
  assert.deepEqual(tokenFields(serverRow("qonto")).map((field) => field.name), ["login", "secret_key"]);
  const declared = serverRow("acme", {
    manifest: { ...serverRow("acme").manifest, auth: { kind: "token", fields: [{ name: "api_key", label: "Key" }] } },
  });
  assert.deepEqual(tokenFields(declared), [{ name: "token", label: "API key", optional: false }]);
});

test("overridden_copy_fields_names_the_copy_fields_an_override_replaces", () => {
  assert.deepEqual(overriddenCopyFields(serverRow("notion", { overrides: { description: "Ours.", tools: {} } })), ["description"]);
  assert.deepEqual(overriddenCopyFields(serverRow("notion")), []);
});

test("edit_copy_overrides_clears_on_null_replaces_with_the_checked_value_and_keeps_fields_it_does_not_name", () => {
  const checks = {
    display_name: (value: unknown) => String(value).trim(),
    description: (value: unknown) => `checked ${String(value)}`,
    limitations: (value: unknown) => String(value),
    setup_hint: (value: unknown) => String(value),
  };
  const edited = editCopyOverrides(
    { display_name: "Old", limitations: "Keep", tools: { a: { default: true } } },
    { display_name: null, description: "new", setup_hint: undefined, slug: "ignored" },
    checks,
  );
  assert.deepEqual(edited, { limitations: "Keep", description: "checked new", tools: { a: { default: true } } });
});

test("connector_code_is_the_endpoint_alone_for_a_server_the_box_runs_no_connector_for", () => {
  assert.deepEqual(connectorCode(serverRow("acme", { id: "mcp_acme" })), { manifest: null, adapter: {}, endpoint: true });
});

test("connector_code_is_the_installed_connector_with_calls_to_the_endpoint_its_manifest_has", () => {
  const notion = connectorCode(serverRow("notion"));
  assert.equal(notion.manifest, CONNECTORS.bySlug("notion")!.manifest);
  assert.equal(notion.adapter, CONNECTORS.bySlug("notion")!.adapter);
  assert.equal(notion.endpoint, true);
  runConnectors(WITH_QUOTES);
  const quotes = connectorCode(serverRow("quotes"));
  assert.equal(typeof quotes.adapter.state, "function");
  assert.equal(quotes.endpoint, false);
});

test("state_hooks_list_each_running_connector_with_a_state_hook", () => {
  assert.equal(stateHooks().some((hook) => hook.serverId === "mcp_quotes"), false);
  runConnectors(WITH_QUOTES);
  const quotes = stateHooks().find((hook) => hook.serverId === "mcp_quotes");
  assert.equal(quotes?.key, "quotes");
  assert.equal(quotes?.manifest.slug, "quotes");
});

test("installed_manifests_are_the_manifests_of_the_connectors_the_box_runs", () => {
  assert.deepEqual(
    installedManifests().map((manifest) => manifest.slug),
    CONNECTORS.entries().map((entry) => entry.manifest.slug),
  );
  assert.deepEqual(installedConnectorBySlug("notion"), { id: "mcp_notion", display_name: CONNECTORS.bySlug("notion")!.manifest.display_name });
  assert.equal(installedConnectorBySlug("acme"), null);
});

test("logo_path_is_the_running_connectors_logo_or_null", () => {
  assert.match(logoPath("mcp_notion") ?? "", /notion\/logo\.svg$/);
  assert.equal(logoPath("mcp_acme"), null);
});
