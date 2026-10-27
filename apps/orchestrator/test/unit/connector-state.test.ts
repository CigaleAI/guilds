import assert from "node:assert/strict";
import { test } from "node:test";
import { agentMcpConnection } from "../../src/access/runtime.js";
import { installConnectors } from "../../src/connectors/index.js";
import { connectionSettings } from "../../src/mcp/index.js";
import { STATE_INTRO, composeSystemPrompt } from "../../src/prompts/index.js";
import { collectRunState } from "../../src/state/index.js";
import { QUOTES } from "../helpers/quotes.js";

installConnectors([QUOTES]);

const QUOTES_INTRO = QUOTES.manifest.state!.intro;
const PINNED = [{ id: "ethereum", name: "Ethereum" }];

function pinnedDb(options: { serverOff?: boolean; status?: string } = {}) {
  return {
    listBindingsCovering: async () => [
      {
        catalog_kind: "mcp",
        catalog_id: "mcp_quotes",
        scope: "org",
        scope_id: "org_1",
        enabled: !options.serverOff,
        connection_id: "conn_quotes",
      },
    ],
    listAgentSecrets: async () => [],
    listMcpServers: async () => [{ id: "mcp_quotes", slug: "quotes" }],
    listMcpConnections: async () => [
      { id: "conn_quotes", status: options.status ?? "connected", settings: { symbols: PINNED } },
    ],
    listMcpTools: async () => [],
  };
}

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

test("agentMcpConnection reads a login's settings, and leaves out a server that is off or a login disconnected", async () => {
  const agent = { id: "agent_1", guild_id: "guild_1", org_id: "org_1" };
  const found = await agentMcpConnection(pinnedDb() as never, agent, "quotes");
  assert.equal(found?.id, "conn_quotes");
  assert.deepEqual(connectionSettings(found!).symbols, PINNED);
  assert.equal(await agentMcpConnection(pinnedDb({ serverOff: true }) as never, agent, "quotes"), null);
  assert.equal(await agentMcpConnection(pinnedDb({ status: "disconnected" }) as never, agent, "quotes"), null);
});
