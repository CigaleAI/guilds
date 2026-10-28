import assert from "node:assert/strict";
import { test } from "node:test";
import { agentLogins } from "../../src/access/runtime.js";
import { installConnectors } from "../../src/connectors/index.js";
import type { BindingRow } from "../../src/db/bindings.js";
import type { McpConnectionRow, ScopedMcpConnectionRow } from "../../src/db/mcp.js";
import { previewConnectorState } from "../../src/mcp/index.js";
import { STATE_INTRO, composeSystemPrompt } from "../../src/prompts/index.js";
import { collectRunState } from "../../src/state/index.js";
import { QUOTES } from "../helpers/quotes.js";
import { connectionRow, serverRow } from "../helpers/servers.js";

installConnectors([QUOTES]);

const QUOTES_INTRO = QUOTES.manifest.state!.intro;
const PINNED = [{ id: "ethereum", name: "Ethereum" }];

test("collect_run_state adds connector entries beside core's keys", () => {
  const base = { members: [], historyRows: [] };
  assert.equal("quotes" in collectRunState(null, "org", "guild", "agent", base), false);
  const quotes = [{ id: "ethereum", price: 3200 }];
  const state = collectRunState(null, "org", "guild", "agent", { ...base, connectors: { quotes, group: "shadow" } });
  assert.deepEqual(state.quotes, quotes);
  assert.notEqual(state.group, "shadow");
});

test("compose explains a connector's State key only when State carries it", () => {
  const bare = composeSystemPrompt("Be brief.", "Do the work.", { group: {} }, "");
  assert.ok(bare.includes(STATE_INTRO));
  assert.ok(!bare.includes(QUOTES_INTRO));
  const quoted = composeSystemPrompt("Be brief.", "Do the work.", { group: {}, quotes: [{ id: "ethereum", price: 3200 }] }, "");
  assert.ok(quoted.includes(`${STATE_INTRO} ${QUOTES_INTRO}`));
});

/** An organisation's quotes login, bound on for its agents unless `serverOff`. */
function quotesLogins(options: { serverOff?: boolean; status?: McpConnectionRow["status"] } = {}) {
  const binding: BindingRow = {
    id: "bind_quotes",
    catalog_kind: "mcp",
    catalog_id: "mcp_quotes",
    scope: "org",
    scope_id: "org_1",
    enabled: !options.serverOff,
    connection_id: "conn_quotes",
    created_at: "2026-10-12T09:00:00.000Z",
    updated_at: "2026-10-12T09:00:00.000Z",
  };
  const login: ScopedMcpConnectionRow = {
    ...connectionRow({ id: "conn_quotes", mcp_server_id: "mcp_quotes", status: options.status ?? "connected", settings: { symbols: PINNED } }),
    org_id: "org_1",
    guild_id: null,
    agent_id: null,
  };
  return {
    listBindingsCovering: async () => [binding],
    listMcpServers: async () => [serverRow("quotes", { id: "mcp_quotes" })],
    listMcpConnections: async () => [login],
  };
}

test("agentLogins reads a login's settings, and leaves out a server that is off or a login disconnected", async () => {
  const agent = { id: "agent_1", guild_id: "guild_1", org_id: "org_1" };
  const [found, ...rest] = await agentLogins(quotesLogins(), agent);
  assert.equal(found?.connection.id, "conn_quotes");
  assert.equal(found?.server.slug, "quotes");
  assert.deepEqual(found?.connection.settings.symbols, PINNED);
  assert.deepEqual(rest, []);
  assert.deepEqual(await agentLogins(quotesLogins({ serverOff: true }), agent), []);
  assert.deepEqual(await agentLogins(quotesLogins({ status: "disconnected" }), agent), []);
});

test("previewConnectorState marks the key of each connector an agent's logins sign into as fetched at run start", async () => {
  const agent = { id: "agent_1", guild_id: "guild_1", org_id: "org_1" };
  assert.deepEqual(previewConnectorState(await agentLogins(quotesLogins(), agent)), {
    [QUOTES.manifest.state!.key]: { unavailable: "fetched live at run start" },
  });
  assert.deepEqual(previewConnectorState([]), {});
});
