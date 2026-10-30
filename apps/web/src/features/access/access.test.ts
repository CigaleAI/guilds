import assert from "node:assert/strict";
import { test } from "node:test";
import type { Instance } from "../../api/types/admin";
import type { AccessBinding, McpServerAccess } from "../../api/types/access";
import {
  BROWSER_NATIVE_TOOLS,
  bindingOrigin,
  canResetFirst,
  connectionStatus,
  filterTools,
  isCapabilityNativeTool,
  listedBrowserTools,
  nativeToolDisplay,
  offersOptimizedBrowser,
  OPTIMIZED_BROWSER_NATIVE_TOOLS,
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
    binding("file_fetch"),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.label, group.tools.map((tool) => tool.name)]),
    [
      ["Notes", ["note_find"]],
      ["Files", ["file_fetch"]],
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

test("an agent's Tools tab lists the browser tools of its browser mode", () => {
  const browserNames = (capabilities?: Parameters<typeof withCapabilityNativeTools>[1]) =>
    toolFamilyGroups(withCapabilityNativeTools([binding("note_find")], capabilities))
      .find((group) => group.label === "Browser")
      ?.tools.map((tool) => tool.name);
  assert.deepEqual(browserNames({ browser: true, browser_optimized: true }), [
    "browse",
    "browser_eval",
  ]);
  assert.deepEqual(browserNames({ browser: true }), [...BROWSER_NATIVE_TOOLS]);
  assert.deepEqual(browserNames(), [...BROWSER_NATIVE_TOOLS, "browse"], "every mode with no agent");
  assert.deepEqual(listedBrowserTools({ browser: true, browser_optimized: true }), [
    ...OPTIMIZED_BROWSER_NATIVE_TOOLS,
  ]);
  const offered = withCapabilityNativeTools([binding("browse"), binding("browser_click")], {
    browser: true,
  }).map((tool) => tool.name);
  assert.equal(offered.includes("browse"), false, "a listed tool of the other mode is left out");
  assert.equal(offered.filter((name) => name === "browser_click").length, 1);
});

test("the browse tool says which browser it needs where no agent is in view", () => {
  assert.deepEqual(nativeToolDisplay(binding("browse"), "guild"), {
    enabled: true,
    caption: "Offered when an agent has the agent-optimized browser on",
    bindable: false,
  });
  assert.deepEqual(
    nativeToolDisplay(binding("browse"), "agent", { browser: true, browser_optimized: true }),
    { enabled: true, caption: "Active via browser", bindable: false },
  );
  assert.equal(isCapabilityNativeTool("browse"), true);
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
  assert.deepEqual(nativeToolDisplay(binding("code_task"), "agent", { coding: true }), {
    enabled: true,
    caption: "Active via coding",
    bindable: false,
  });
  assert.deepEqual(nativeToolDisplay(binding("shell"), "org"), {
    enabled: true,
    caption: "Offered when an agent has coding on",
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

test("the agent-optimized browser is listed only while its platform key is on, as the server offers it", () => {
  const box = (state: "on" | "off"): Instance => ({
    auth_mode: "compat-cookie",
    integrations: [
      {
        id: "system-one",
        label: "System One",
        enables: "The agent-optimized browser",
        source: "store",
        state,
        fields: [
          {
            name: "api_key",
            label: "API key",
            optional: false,
            secret: true,
            multiline: false,
            set: state === "on",
          },
        ],
        setup: null,
        updated_at: null,
        set_by: null,
        provides: { native_tools: ["browse"], connectors: [] },
      },
    ],
  });
  assert.equal(offersOptimizedBrowser({ browser_optimized: true }, box("on")), true);
  assert.equal(offersOptimizedBrowser({ browser_optimized: true }, box("off")), false);
  assert.equal(offersOptimizedBrowser({ browser_optimized: false }, box("on")), false);
  assert.equal(offersOptimizedBrowser(undefined, box("on")), false);
});
