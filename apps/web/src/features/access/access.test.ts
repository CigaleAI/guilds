import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessBinding, AgentAccess, Instance, McpServerAccess } from "../../api/types";
import {
  bindingOrigin,
  canResetFirst,
  connectionStatus,
  filterTools,
  findBinding,
  isCapabilityNativeTool,
  nativeToolDisplay,
  ownedConnection,
  toolFamilyGroups,
  withCapabilityNativeTools,
} from "./access";

function binding(
  name: string,
  enabled = true,
  overrides: Partial<AccessBinding> = {},
): AccessBinding {
  return { name, enabled, source_scope: "platform", overlay: null, ...overrides };
}

function server(overrides: Partial<McpServerAccess> = {}): McpServerAccess {
  return {
    id: "mcp_alchemy",
    slug: "alchemy",
    name: "Alchemy",
    auth: "token",
    auth_fields: [{ name: "token", label: "API key", secret: true }],
    settings_schema: null,
    settings: {},
    needs_settings: false,
    source: "core",
    verified: true,
    experimental: false,
    publisher: "guilds",
    logo_url: "/api/mcp/servers/mcp_alchemy/logo",
    description: "",
    oauth_strategy: "none",
    oauth_setup_state: "not_applicable",
    catalog_enabled: true,
    org_owned: false,
    enabled: true,
    source_scope: "guild",
    overlay: null,
    connection_id: "conn_1",
    status: "connected",
    account_hint: "",
    connection_owner_scope: "guild",
    tools: [
      {
        ...binding("alchemy_holdings"),
        remote_name: "holdings",
        description: "NFTs held",
        input_schema: { type: "object" },
      },
    ],
    ...overrides,
  };
}

test("a target finds its tool, server or server tool", () => {
  const access: AgentAccess = {
    tools: [binding("note_find")],
    mcp: [server()],
  };
  assert.equal(findBinding(access, { kind: "native_tool", id: "note_find" })?.enabled, true);
  assert.equal(findBinding(access, { kind: "mcp", id: "mcp_alchemy" })?.enabled, true);
  assert.equal(findBinding(access, { kind: "mcp_tool", id: "alchemy_holdings" })?.enabled, true);
  assert.equal(findBinding(access, { kind: "native_tool", id: "gone" }), undefined);
});

test("the caption says overridden, inherited, or nothing when set here or unbound", () => {
  assert.equal(bindingOrigin(binding("x", true, { source_scope: "guild" }), "guild"), undefined);
  assert.deepEqual(bindingOrigin(binding("x", true, { overlay: { enabled: true } }), "agent"), {
    kind: "overridden",
  });
  assert.deepEqual(bindingOrigin(binding("x"), "agent"), { kind: "inherited", from: "platform" });
  assert.equal(bindingOrigin(binding("x", false, { source_scope: null }), "agent"), undefined);
});

test("only an override that holds no login is dropped before switching", () => {
  assert.equal(canResetFirst(binding("x", true, { overlay: { enabled: true } })), true);
  assert.equal(
    canResetFirst(binding("x", true, { overlay: { enabled: true, connection_id: "conn_1" } })),
    false,
  );
  assert.equal(canResetFirst(binding("x")), false);
});

test("a server's login reads connected, pending, disconnected, or none", () => {
  assert.equal(connectionStatus(server()), "connected");
  assert.equal(connectionStatus(server({ status: "pending" })), "pending");
  assert.equal(connectionStatus(server({ status: "disconnected" })), "disconnected");
  assert.equal(connectionStatus(server({ connection_id: null, status: null })), undefined);
});

test("only the edited scope's own login can be disconnected", () => {
  assert.equal(ownedConnection(server(), "agent"), null);
  assert.equal(
    ownedConnection(server({ overlay: { enabled: true, connection_id: "conn_1" } }), "guild"),
    "conn_1",
  );
  assert.equal(
    ownedConnection(
      server({
        connection_owner_scope: "agent",
        overlay: { enabled: true, connection_id: "conn_2" },
      }),
      "agent",
    ),
    "conn_2",
  );
});

test("tools filter by state and by name or description", () => {
  const tools = [
    { ...binding("a_search"), description: "Find posts" },
    { ...binding("a_send", false), description: "Send mail" },
  ];
  assert.deepEqual(
    filterTools(tools, "", "active").map((tool) => tool.name),
    ["a_search"],
  );
  assert.deepEqual(
    filterTools(tools, "mail", "all").map((tool) => tool.name),
    ["a_send"],
  );
  assert.deepEqual(
    filterTools(tools, "", "disabled").map((tool) => tool.name),
    ["a_send"],
  );
  assert.deepEqual(
    filterTools(tools, "   ", "all").map((tool) => tool.name),
    ["a_search", "a_send"],
  );
});

test("native tools group by what they work on, including browser, coding and issues", () => {
  const groups = toolFamilyGroups([
    binding("note_find"),
    binding("group_post"),
    binding("browser_navigate"),
    binding("shell"),
    binding("code_search"),
    binding("report_issue"),
    binding("new_tool"),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.label, group.tools.map((tool) => tool.name)]),
    [
      ["Notes", ["note_find"]],
      ["Group chat", ["group_post"]],
      ["Browser", ["browser_navigate"]],
      ["Coding", ["shell", "code_search"]],
      ["Issues", ["report_issue"]],
      ["Other", ["new_tool"]],
    ],
  );
});

test("capability native tools are listed when the access payload omits them", () => {
  const names = withCapabilityNativeTools([binding("note_find")]).map((tool) => tool.name);
  assert.ok(names.includes("note_find"));
  assert.ok(names.includes("browser_navigate"));
  assert.ok(names.includes("shell"));
  assert.ok(names.includes("report_issue"));
  assert.equal(
    withCapabilityNativeTools([binding("browser_navigate")]).filter(
      (tool) => tool.name === "browser_navigate",
    ).length,
    1,
  );
});

test("browser and coding tools follow the agent's capability, not a binding", () => {
  const browser = binding("browser_click");
  assert.deepEqual(nativeToolDisplay(browser, "guild"), {
    enabled: true,
    caption: "Offered when an agent has browser on",
    bindable: false,
  });
  assert.deepEqual(nativeToolDisplay(browser, "agent", { browser: true }), {
    enabled: true,
    caption: "Active via browser",
    bindable: false,
  });
  assert.deepEqual(nativeToolDisplay(browser, "agent", { browser: false }), {
    enabled: false,
    caption: "Offered when browser is on",
    bindable: false,
  });
  assert.deepEqual(nativeToolDisplay(binding("shell"), "agent", { coding: false }), {
    enabled: false,
    caption: "Offered when coding is on",
    bindable: false,
  });
  assert.deepEqual(nativeToolDisplay(binding("report_issue"), "agent"), {
    enabled: true,
    caption: "Always offered",
    bindable: false,
  });
  assert.equal(isCapabilityNativeTool("browser_click"), true);
  assert.equal(isCapabilityNativeTool("shell"), true);
  assert.equal(isCapabilityNativeTool("code_task"), true);
  assert.equal(isCapabilityNativeTool("file_edit"), false);
  assert.equal(isCapabilityNativeTool("report_issue"), true);
  assert.equal(isCapabilityNativeTool("note_find"), false);
});

test("a tool that waits for a platform key is not offered, and says which", () => {
  const box = (
    set: boolean,
    source: Instance["integrations"][number]["source"] = "env",
  ): Instance => ({
    auth_mode: "compat-cookie",
    integrations: [
      {
        id: "lookup",
        label: "Lookup",
        enables: "The lookup_find tool",
        source,
        state: set ? "on" : "off",
        fields: [
          {
            name: "LOOKUP_API_KEY",
            label: "Lookup API key",
            optional: false,
            secret: true,
            multiline: false,
            set,
          },
        ],
        setup: null,
        updated_at: null,
        set_by: null,
        provides: { native_tools: ["lookup_find"], connectors: [] },
      },
    ],
  });
  const search = binding("lookup_find");
  assert.deepEqual(nativeToolDisplay(search, "agent", undefined, box(false)), {
    enabled: false,
    caption: "Offered once this server has Lookup API key set",
    bindable: false,
  });
  assert.deepEqual(nativeToolDisplay(search, "agent", undefined, box(false, "store")), {
    enabled: false,
    caption: "Offered once a platform admin sets up Lookup under Admin → Platform keys",
    bindable: false,
  });
  assert.deepEqual(nativeToolDisplay(search, "agent", undefined, box(true)), {
    enabled: true,
    bindable: true,
  });
  assert.deepEqual(nativeToolDisplay(search, "agent"), { enabled: true, bindable: true });
  assert.deepEqual(nativeToolDisplay(binding("note_find"), "agent", undefined, box(false)), {
    enabled: true,
    bindable: true,
  });
});
