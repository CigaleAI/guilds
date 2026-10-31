import assert from "node:assert/strict";
import { test } from "node:test";
import { findBinding } from "./access";
import type { AccessBinding, AgentAccess, McpServerAccess } from "../types/access";

function binding(name: string): AccessBinding {
  return { name, enabled: true, source_scope: "platform", overlay: null };
}

function server(): McpServerAccess {
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
