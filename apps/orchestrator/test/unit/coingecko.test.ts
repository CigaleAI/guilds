import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMasterKey } from "../../src/config/index.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import {
  CoinGeckoError,
  callTool,
  formatChart,
  formatCoin,
  formatMovers,
  formatSearch,
  formatSupply,
  formatTrending,
  ping,
  searchCoins,
  searchTool,
  simplePrices,
} from "../../src/connectors/coingecko/client.js";
import { agentToolConnection } from "../../src/access/runtime.js";
import { ListedTool, McpError, McpPool, OPERATOR_CALLER } from "../../src/mcp/index.js";
import { CONNECTORS } from "../../src/connectors/index.js";
import { ConnectorError } from "../../src/connectors/types.js";
import { HEX_MASTER_KEY } from "../helpers/env.js";
import { mockFetch } from "../helpers/http.js";
import { serverRow } from "../helpers/servers.js";
import { connectionRow } from "../helpers/servers.js";
import { MemoryMcpDatabase } from "../helpers/mcp-database.js";

const KEY = decodeMasterKey(HEX_MASTER_KEY);
const TOOLS = CONNECTORS.bySlug("coingecko")!.manifest.tools!;


test("formatSearch drops images and exchanges", () => {
  const payload = {
    coins: [{
      id: "ethereum",
      name: "Ethereum",
      symbol: "ETH",
      market_cap_rank: 2,
      thumb: "https://example.com/eth.png",
      large: "https://example.com/eth-large.png",
    }],
    exchanges: [{ id: "uniswap_v3", name: "Uniswap V3" }],
    nfts: [{ id: "ens", name: "ENS", symbol: "ENS", thumb: "x" }],
    categories: [{ id: "layer-1", name: "Layer 1" }],
  };
  const stored = formatSearch(payload);
  assert.equal(stored, "coins\nethereum  ETH  Ethereum  #2\n\nnfts\nens  ENS  ENS\n\ncategories\nlayer-1  Layer 1");
  assert.ok(!stored.includes("example.com"));
  assert.ok(!stored.includes("uniswap"));
});

test("formatSearch caps rows", () => {
  const payload = {
    coins: Array.from({ length: 20 }, (_, index) => ({
      id: `c${index}`,
      symbol: "x",
      name: `Coin ${index}`,
      market_cap_rank: index,
    })),
  };
  const stored = formatSearch(payload, 3);
  assert.equal(stored.split("\n").length - 1, 4);
  assert.ok(stored.includes("+17 more"));
});

test("formatCoin keeps platforms and lean market", () => {
  const payload = {
    id: "uniswap",
    symbol: "uni",
    name: "Uniswap",
    market_cap_rank: 28,
    description: { en: "<p>long html</p>" },
    image: { large: "https://example.com/uni.png" },
    platforms: {
      ethereum: "0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3",
      solana: "",
    },
    market_data: {
      current_price: { usd: 6.12, btc: 0.00007 },
      market_cap: { usd: 3.8e9 },
      total_volume: { usd: 1.2e8 },
      circulating_supply: 622_047_561,
      total_supply: 894_182_420,
      price_change_percentage_24h: 1.2,
    },
  };
  const stored = formatCoin(payload);
  assert.ok(stored.includes("uniswap  uni  Uniswap  #28"));
  assert.ok(stored.includes("p=6.12"));
  assert.ok(stored.includes("ethereum=0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3"));
  assert.ok(!stored.includes("solana"));
  assert.ok(!stored.includes("long html"));
  assert.ok(!stored.includes("example.com"));
});

test("formatMovers and formatSupply drop images", () => {
  const movers = formatMovers({
    top_gainers: [{
      id: "maga",
      symbol: "mbtc",
      name: "MAGA",
      image: "https://example.com/m.png",
      market_cap_rank: 189,
      usd: 0.174,
      usd_24h_vol: 50396,
      usd_24h_change: 150.5,
    }],
    top_losers: [],
  });
  assert.equal(movers, "gainers\nmaga  mbtc  MAGA  #189  0.174  50396  +150.5%");
  assert.ok(!movers.includes("example.com"));
  const supply = formatSupply({
    id: "uniswap",
    symbol: "uni",
    name: "Uniswap",
    supply_data: {
      total_supply: 894_182_420,
      circulating_supply: 622_047_561,
      outstanding_supply: 0,
      non_circulating_supply: 272_134_858,
    },
    non_circulating_wallets: [{
      address: "0x1a9C8182C09F50C8318d769245beA52c32BE35BC",
      label: "UNI Timelock",
      balance: 272_134_858,
      percentage_of_total_supply: 30.43,
      anomaly: true,
    }],
  });
  assert.ok(supply.includes("circ=6.22e+08"));
  assert.ok(supply.includes("UNI Timelock"));
  assert.ok(supply.includes("anomaly"));
});

test("formatChart downsamples and keeps price only", () => {
  const prices = Array.from({ length: 200 }, (_, index) => [1_710_000_000_000 + index * 60_000, 65_000 + index]);
  const stored = formatChart(
    {
      prices,
      market_caps: prices.map(([ts]) => [ts, 1e12]),
      total_volumes: prices.map(([ts]) => [ts, 2e10]),
    },
    { title: "bitcoin usd 7d" },
  );
  const lines = stored.split("\n");
  assert.equal(lines[0], "bitcoin usd 7d n=48");
  assert.equal(lines[1], "t  p");
  assert.equal(lines.length, 50);
  assert.ok(!lines[1]?.includes("m"));
  assert.ok(!stored.includes("1e+12"));
});

test("formatTrending drops media", () => {
  const payload = {
    coins: [{
      item: {
        id: "bonk",
        name: "Bonk",
        symbol: "BONK",
        market_cap_rank: 103,
        thumb: "https://example.com/bonk.png",
        data: {
          price: 0.00000594,
          price_change_percentage_24h: { usd: -3.27 },
          sparkline: "https://example.com/spark.svg",
        },
      },
    }],
    nfts: [],
    categories: [],
  };
  assert.equal(formatTrending(payload), "coins\nbonk  BONK  Bonk  #103  5.94e-06  -3.27%");
});

test("search uses the pro key header", async () => {
  let url = "";
  let key = "";
  const stored = await searchTool(
    { query: "bitcoin" },
    {
      apiKey: "cg-test",
      client: mockFetch((requestUrl, init) => {
        url = requestUrl;
        const headers = init?.headers as Record<string, string>;
        key = headers["x-cg-pro-api-key"] ?? headers["X-CG-PRO-API-KEY"] ?? "";
        return { status: 200, json: { coins: [{ id: "bitcoin", symbol: "btc", name: "Bitcoin" }] } };
      }),
    },
  );
  assert.equal(url, "https://pro-api.coingecko.com/api/v3/search?query=bitcoin");
  assert.equal(key, "cg-test");
  assert.equal(stored, "coins\nbitcoin  btc  Bitcoin");
});

test("ping rejects unauthorized", async () => {
  await assert.rejects(
    () => ping("bad", { client: mockFetch(() => ({ status: 401, json: { error: "invalid key" } })) }),
    (error: unknown) => error instanceof CoinGeckoError && error.status === 401 && /invalid key/.test(error.message),
  );
});

test("callTool unknown name", async () => {
  await assert.rejects(() => callTool("onchain", {}, { apiKey: "cg-test" }), /unknown CoinGecko tool/);
});

test("sync CoinGecko writes the curated catalog", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  let pinged = 0;
  const pool = new McpPool(new MemoryMcpDatabase(), 10 * 60 * 1000);
  pool.connectors = CONNECTORS.withAdapter("coingecko", {
    async validate(creds) {
      const apiKey = creds.token;
      pinged += 1;
      assert.equal(apiKey, "cg-test");
      return "";
    },
  });
  const [ciphertext, nonce] = encryptPayload({ token: "cg-test" }, KEY);
  const connection = connectionRow({ id: "conn_cg", status: "connected", ciphertext, nonce });
  const server = serverRow("coingecko", { id: "mcp_coingecko", auth: "token" });
  const first = await pool.syncTools(connection, server, { force: true });
  const second = await pool.syncTools(connection, server);
  assert.equal(pinged, 1);
  assert.deepEqual(first.map((tool) => tool.namespaced_name), TOOLS.map((spec) => `coingecko_${spec.name}`));
  assert.deepEqual(first, second);
  assert.deepEqual(first[0], new ListedTool("search", "coingecko_search", TOOLS[0]!.description, TOOLS[0]!.input_schema));
});

test("sync CoinGecko rejects a bad key", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const pool = new McpPool(new MemoryMcpDatabase());
  pool.connectors = CONNECTORS.withAdapter("coingecko", {
    async validate() {
      throw new ConnectorError("invalid key", 401);
    },
  });
  const [ciphertext, nonce] = encryptPayload({ token: "bad" }, KEY);
  await assert.rejects(
    () => pool.syncTools(connectionRow({ id: "conn_cg", status: "connected", ciphertext, nonce }), serverRow("coingecko", { id: "mcp_coingecko", auth: "token" }), { force: true }),
    (error: unknown) => error instanceof McpError && error.status === 401 && error.message === "invalid key",
  );
});

test("call CoinGecko dispatches", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const seen: Record<string, unknown> = {};
  const pool = new McpPool(new MemoryMcpDatabase());
  pool.connectors = CONNECTORS.withAdapter("coingecko", {
    async call(name, arguments_, creds) {
      seen.name = name;
      seen.arguments = arguments_;
      seen.api_key = creds.token;
      return "coins\nbitcoin  btc  Bitcoin";
    },
  });
  const [ciphertext, nonce] = encryptPayload({ token: "cg-test" }, KEY);
  const stored = await pool.call(
    connectionRow({ id: "conn_cg", status: "connected", ciphertext, nonce }),
    serverRow("coingecko", { id: "mcp_coingecko", auth: "token" }),
    { tool: "search", arguments: { query: "bitcoin" }, caller: OPERATOR_CALLER },
  );
  assert.equal(stored, "coins\nbitcoin  btc  Bitcoin");
  assert.deepEqual(seen, { name: "search", arguments: { query: "bitcoin" }, api_key: "cg-test" });
});

test("simplePrices asks for USD, 24h change, and last update", async () => {
  let url = "";
  const prices = await simplePrices(["ethereum", "bitcoin", "gone"], {
    apiKey: "cg-test",
    client: mockFetch((requestUrl) => {
      url = requestUrl;
      return {
        status: 200,
        json: {
          ethereum: { usd: 3200.5, usd_24h_change: -1.2345, last_updated_at: 1_790_000_000 },
          bitcoin: { usd: 98000 },
          gone: {},
        },
      };
    }),
  });
  const parsed = new URL(url);
  assert.equal(parsed.pathname, "/api/v3/simple/price");
  assert.equal(parsed.searchParams.get("ids"), "ethereum,bitcoin,gone");
  assert.equal(parsed.searchParams.get("vs_currencies"), "usd");
  assert.equal(parsed.searchParams.get("include_24hr_change"), "true");
  assert.equal(parsed.searchParams.get("include_last_updated_at"), "true");
  assert.deepEqual(prices, {
    ethereum: { usd: 3200.5, change_24h: -1.2345, updated_at: 1_790_000_000 },
    bitcoin: { usd: 98000, change_24h: null, updated_at: null },
  });
});

test("searchCoins returns structured coin matches", async () => {
  const coins = await searchCoins("eth", {
    apiKey: "cg-test",
    client: mockFetch(() => ({
      status: 200,
      json: {
        coins: [
          { id: "ethereum", symbol: "eth", name: "Ethereum", market_cap_rank: 2, thumb: "https://x/eth.png" },
          { symbol: "nope" },
        ],
      },
    })),
  });
  assert.deepEqual(coins, [
    { id: "ethereum", symbol: "ETH", name: "Ethereum", market_cap_rank: 2, thumb: "https://x/eth.png" },
  ]);
  await assert.rejects(() => searchCoins("  ", { apiKey: "cg-test" }), CoinGeckoError);
});

test("prices tool quotes each requested id once", async () => {
  let url = "";
  const text = await callTool(
    "prices",
    { ids: "Ethereum, gone, ethereum" },
    {
      apiKey: "cg-test",
      client: mockFetch((requestUrl) => {
        url = requestUrl;
        return {
          status: 200,
          json: { ethereum: { usd: 3200.5, usd_24h_change: 1.5, last_updated_at: 1_790_000_000 } },
        };
      }),
    },
  );
  assert.equal(new URL(url).searchParams.get("ids"), "ethereum,gone");
  const [eth, gone] = text.split("\n");
  assert.match(eth!, /^ethereum\s+p=3,?200\.5\s+chg_24h=\+1\.5%\s+1790000000$/);
  assert.match(gone!, /^gone\s+no price$/);
  await assert.rejects(() => callTool("prices", { ids: " , " }, { apiKey: "cg-test" }), /ids is required/);
});

function toolDb(options: { toolOff?: boolean; serverOff?: boolean; status?: string; listed?: boolean } = {}) {
  const bindings: Array<Record<string, unknown>> = [
    {
      catalog_kind: "mcp",
      catalog_id: "mcp_coingecko",
      scope: "org",
      scope_id: "org_1",
      enabled: !options.serverOff,
      connection_id: "conn_1",
    },
  ];
  if (options.toolOff) {
    bindings.push({
      catalog_kind: "mcp_tool",
      catalog_id: "coingecko_prices",
      scope: "agent",
      scope_id: "agent_1",
      enabled: false,
      connection_id: null,
    });
  }
  return {
    listBindingsCovering: async () => bindings,
    listAgentSecrets: async () => [],
    listMcpServers: async () => [{ id: "mcp_coingecko", slug: "coingecko" }],
    listMcpConnections: async () => [{ id: "conn_1", status: options.status ?? "connected" }],
    connectionTools: async () =>
      options.listed === false
        ? [{ remote_name: "search", namespaced_name: "coingecko_search" }]
        : [{ remote_name: "prices", namespaced_name: "coingecko_prices" }],
  };
}

test("agentToolConnection follows the prices tool toggle", async () => {
  const agent = { id: "agent_1", guild_id: "guild_1", org_id: "org_1" };
  const found = await agentToolConnection(toolDb() as never, agent, "coingecko", "prices");
  assert.equal(found?.id, "conn_1");
  for (const off of [
    { toolOff: true },
    { serverOff: true },
    { status: "disconnected" },
    { listed: false },
  ]) {
    assert.equal(await agentToolConnection(toolDb(off) as never, agent, "coingecko", "prices"), null, JSON.stringify(off));
  }
});
