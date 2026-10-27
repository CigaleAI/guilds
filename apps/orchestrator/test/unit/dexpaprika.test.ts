import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMasterKey } from "../../src/config/index.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import {
  DexPaprikaError,
  callTool,
  formatOhlcv,
  formatPool,
  formatPools,
  formatPrices,
  formatSearch,
  formatSwaps,
  formatToken,
  ping,
  searchTool,
} from "../../src/connectors/dexpaprika/client.js";
import { ListedTool, McpError, McpPool } from "../../src/mcp/index.js";
import { CONNECTORS } from "../../src/connectors/index.js";
import { ConnectorError } from "../../src/connectors/types.js";
import { HEX_MASTER_KEY } from "../helpers/env.js";
import { mockFetch } from "../helpers/http.js";
import { serverRow } from "../helpers/servers.js";
import { connectionRow } from "../helpers/servers.js";

const KEY = decodeMasterKey(HEX_MASTER_KEY);
const TOOLS = CONNECTORS.bySlug("dexpaprika")!.manifest.tools!;

class MemoryDb {
  rows: Array<Record<string, unknown>> = [];
  async replaceMcpTools(_id: string, tools: ListedTool[]) {
    this.rows = tools.map((tool) => ({ ...tool }));
  }
  async listMcpTools() {
    return this.rows;
  }
}

test("formatSearch drops descriptions and caps rows", () => {
  const payload = {
    tokens: [{
      id: "So11111111111111111111111111111111111111112",
      name: "Wrapped SOL",
      symbol: "SOL",
      chain: "solana",
      price_usd: 103.8,
      description: "long html",
      website: "https://solana.com",
    }],
    pools: [{
      id: "pool-1",
      dex_name: "Raydium",
      chain: "solana",
      volume_usd_24h: 1_200_000,
      tokens: [
        { symbol: "SOL", id: "So11111111111111111111111111111111111111112" },
        { symbol: "USDC", id: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
      ],
    }],
    dexes: [{ dex_id: "raydium", dex_name: "Raydium", chain: "solana", volume_usd_24h: 9e9 }],
  };
  const stored = formatSearch(payload, 15);
  assert.equal(
    stored,
    "tokens\nsolana  So11111111111111111111111111111111111111112  SOL  Wrapped SOL  p=103.8\n\n"
      + "pools\nsolana  pool-1  Raydium  SOL/USDC  vol=1.2e+06\n\n"
      + "dexes\nsolana  raydium  Raydium  vol=9e+09",
  );
  assert.ok(!stored.includes("solana.com"));
  assert.ok(!stored.includes("long html"));
});

test("formatSearch caps rows", () => {
  const payload = {
    tokens: Array.from({ length: 20 }, (_, index) => ({
      id: `t${index}`,
      symbol: "x",
      name: `Token ${index}`,
      chain: "ethereum",
      price_usd: index,
    })),
  };
  const stored = formatSearch(payload, 3);
  assert.equal(stored.split("\n").length - 1, 4);
  assert.ok(stored.includes("+17 more"));
});

test("formatToken keeps lean market", () => {
  const payload = {
    id: "So11111111111111111111111111111111111111112",
    name: "Wrapped SOL",
    symbol: "SOL",
    chain: "solana",
    website: "https://solana.com",
    twitter: "https://twitter.com/solana",
    summary: {
      price_usd: 103.8,
      fdv: 1e9,
      liquidity_usd: 5.5e8,
      pools: 12897,
      "24h": { volume_usd: 5.1e9, last_price_usd_change: 0.67 },
    },
  };
  const stored = formatToken(payload);
  assert.equal(
    stored,
    "solana  So11111111111111111111111111111111111111112  SOL  Wrapped SOL\n"
      + "p=103.8  liq=5.5e+08  fdv=1e+09  vol_24h=5.1e+09  chg_24h=+0.67%  pools=12897",
  );
  assert.ok(!stored.includes("solana.com"));
});

test("formatPrices and formatPool", () => {
  assert.equal(
    formatPrices([
      { id: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", chain: "ethereum", price_usd: 4400.56 },
    ]),
    "ethereum  0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2  p=4400.56",
  );
  const stored = formatPool({
    id: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
    chain: "ethereum",
    dex_name: "Uniswap V3",
    price_usd: 3500,
    liquidity_usd: 2e8,
    volume_usd_24h: 1e8,
    last_price_change_usd_24h: -1.2,
    txns_24h: 44000,
    tokens: [{ symbol: "WETH" }, { symbol: "USDC" }],
  });
  assert.equal(
    stored,
    "ethereum  0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640  Uniswap V3  WETH/USDC\n"
      + "p=3500  liq=2e+08  vol_24h=1e+08  chg_24h=-1.2%  tx_24h=44000",
  );
});

test("formatPools pages and formatOhlcv downsamples", () => {
  const stored = formatPools(
    {
      results: [
        {
          id: "pool-1",
          chain: "base",
          dex_name: "Aerodrome",
          volume_usd: 12_000,
          tokens: [{ symbol: "AERO" }, { symbol: "USDC" }],
        },
      ],
      next_cursor: "cur-2",
    },
    15,
  );
  assert.equal(stored, "base  pool-1  Aerodrome  AERO/USDC  p=-  liq=-  vol=12000\npage=cur-2");
  const candles = formatOhlcv(
    [
      { time_open: "2026-03-10T00:00:00Z", open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
      { time_open: "2026-03-10T01:00:00Z", open: 1.5, high: 2.5, low: 1, close: 2, volume: 12 },
    ],
    "ethereum:0x88 1h -24h",
  );
  assert.equal(
    candles,
    "ethereum:0x88 1h -24h ohlc n=2\n"
      + "t  o  h  l  c  v\n"
      + "2026-03-10T00:00:00Z  1  2  0.5  1.5  10\n"
      + "2026-03-10T01:00:00Z  1.5  2.5  1  2  12",
  );
});

test("formatSwaps keeps amounts", () => {
  const stored = formatSwaps({
    transactions: [{
      id: "0xabc",
      created_at: "2026-03-10T00:00:00Z",
      token_0_symbol: "WETH",
      token_1_symbol: "USDC",
      amount_0: "0.4",
      amount_1: "1400",
      price_0_usd: 3500,
    }],
    page_info: { next_cursor: "tx-2" },
  });
  assert.equal(
    stored,
    "2026-03-10T00:00:00Z  0xabc  WETH  0.4  USDC  1400  p0=3500\npage=tx-2",
  );
});

test("searchTool sends the raw Authorization header", async () => {
  let url = "";
  let key = "";
  const stored = await searchTool(
    { query: "sol" },
    {
      apiKey: "api_test",
      client: mockFetch((requestUrl, init) => {
        url = requestUrl;
        const headers = init?.headers as Record<string, string>;
        key = headers.Authorization ?? "";
        return { status: 200, json: { tokens: [{ id: "sol", symbol: "SOL", name: "Solana", chain: "solana", price_usd: 100 }] } };
      }),
    },
  );
  assert.equal(url, "https://api.dexpaprika.com/search?query=sol");
  assert.equal(key, "api_test");
  assert.equal(stored, "tokens\nsolana  sol  SOL  Solana  p=100");
});

test("ping rejects keyless and unauthorized", async () => {
  await assert.rejects(
    () => ping("bad", { client: mockFetch(() => ({ status: 200, json: { plan: "keyless" } })) }),
    (error: unknown) => error instanceof DexPaprikaError && error.status === 401,
  );
  await assert.rejects(
    () => ping("bad", { client: mockFetch(() => ({ status: 401, json: { error: "invalid key" } })) }),
    (error: unknown) => error instanceof DexPaprikaError && error.status === 401 && /invalid key/.test(error.message),
  );
});

test("getJson retries the Pro host on 403", async () => {
  const hosts: string[] = [];
  await ping("api_pro", {
    client: mockFetch((url) => {
      hosts.push(url);
      if (url.startsWith("https://api.dexpaprika.com")) {
        return { status: 403, json: { error: "use pro host" } };
      }
      return { status: 200, json: { plan: "pro" } };
    }),
  });
  assert.deepEqual(hosts, [
    "https://api.dexpaprika.com/usage",
    "https://api-pro.dexpaprika.com/usage",
  ]);
});

test("callTool unknown name", async () => {
  await assert.rejects(() => callTool("stream", {}, { apiKey: "api_test" }), /unknown DexPaprika tool/);
});

test("sync DexPaprika writes the curated catalog", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  let pinged = 0;
  const pool = new McpPool(10 * 60 * 1000);
  pool.connectors = CONNECTORS.withAdapter("dexpaprika", {
    async validate(creds) {
      const apiKey = creds.token;
      pinged += 1;
      assert.equal(apiKey, "api_test");
      return "";
    },
  });
  const [ciphertext, nonce] = encryptPayload({ token: "api_test" }, KEY);
  const db = new MemoryDb();
  const connection = connectionRow({ id: "conn_dp", status: "connected", ciphertext, nonce });
  const server = serverRow("dexpaprika", { id: "mcp_dexpaprika", auth: "token" });
  const first = await pool.syncTools(db as never, connection, server, { force: true });
  const second = await pool.syncTools(db as never, connection, server);
  assert.equal(pinged, 1);
  assert.deepEqual(first.map((tool) => tool.namespaced_name), TOOLS.map((spec) => `dexpaprika_${spec.name}`));
  assert.deepEqual(first, second);
  assert.deepEqual(first[0], new ListedTool("search", "dexpaprika_search", TOOLS[0]!.description, TOOLS[0]!.input_schema));
});

test("sync DexPaprika rejects a bad key", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const pool = new McpPool();
  pool.connectors = CONNECTORS.withAdapter("dexpaprika", {
    async validate() {
      throw new ConnectorError("invalid key", 401);
    },
  });
  const [ciphertext, nonce] = encryptPayload({ token: "bad" }, KEY);
  await assert.rejects(
    () => pool.syncTools(new MemoryDb() as never, connectionRow({ id: "conn_dp", status: "connected", ciphertext, nonce }), serverRow("dexpaprika", { id: "mcp_dexpaprika", auth: "token" }), { force: true }),
    (error: unknown) => error instanceof McpError && error.status === 401 && error.message === "invalid key",
  );
});

test("call DexPaprika dispatches", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const seen: Record<string, unknown> = {};
  const pool = new McpPool();
  pool.connectors = CONNECTORS.withAdapter("dexpaprika", {
    async call(name, arguments_, creds) {
      seen.name = name;
      seen.arguments = arguments_;
      seen.api_key = creds.token;
      return "tokens\nsolana  sol  SOL  Solana  p=100";
    },
  });
  const [ciphertext, nonce] = encryptPayload({ token: "api_test" }, KEY);
  const stored = await pool.call(
    new MemoryDb() as never,
    connectionRow({ id: "conn_dp", status: "connected", ciphertext, nonce }),
    serverRow("dexpaprika", { id: "mcp_dexpaprika", auth: "token" }),
    "search",
    { query: "sol" },
  );
  assert.equal(stored, "tokens\nsolana  sol  SOL  Solana  p=100");
  assert.deepEqual(seen, { name: "search", arguments: { query: "sol" }, api_key: "api_test" });
});
