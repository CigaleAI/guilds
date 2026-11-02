import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMasterKey } from "../../src/config/index.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import {
  AlchemyError,
  CHAINS,
  formatCollection,
  formatHoldings,
  formatNft,
  ping,
} from "../../src/connectors/alchemy/client.js";
import { McpError } from "../../src/mcp/errors.js";
import { McpPool, OPERATOR_CALLER } from "../../src/mcp/pool.js";
import { CONNECTORS } from "../../src/connectors/index.js";
import { ConnectorError, type ConnectorContext } from "../../src/connectors/types.js";
import type { JsonObject } from "../../src/lib/json.js";
import type { FetchFn } from "../../src/net/http.js";
import { HEX_MASTER_KEY } from "../helpers/env.js";
import { mockFetch } from "../helpers/http.js";
import { serverRow } from "../helpers/servers.js";
import { connectionRow } from "../helpers/servers.js";
import { MemoryMcpDatabase } from "../helpers/mcp-database.js";
import { restoreConnectorsAfterEach, runConnectors } from "../helpers/installed.js";

restoreConnectorsAfterEach();

const KEY = decodeMasterKey(HEX_MASTER_KEY);
const ALCHEMY = CONNECTORS.bySlug("alchemy")!;
const TOOLS = ALCHEMY.manifest.tools!;

/** Runs the Alchemy tool `name` on `args` with the key alc-test, fetching through `http`. */
function callAlchemy(name: string, args: JsonObject, http: FetchFn = mockFetch(() => ({ status: 500, json: {} }))) {
  const ctx: ConnectorContext = {
    http,
    remote: { initialize: async () => ({ name: "", instructions: "" }), list: async () => [], call: async () => "" },
    connection_id: "conn_alc",
    settings: {},
  };
  return ALCHEMY.adapter.call!(name, args, { token: "alc-test" }, ctx);
}

/** Whether `error` is the connector error a call is refused with: `status`, its message matching `pattern`. */
function refused(status: number | null, pattern: RegExp) {
  return (error: unknown) => error instanceof ConnectorError && error.status === status && pattern.test(error.message);
}


test("formatHoldings drops images and descriptions", () => {
  const payload = {
    ownedNfts: [{
      contract: {
        address: "0x0beed7099af7514ccedf642cfea435731176fb02",
        name: "DuskBreakers",
        symbol: "DUSK",
        tokenType: "ERC721",
        isSpam: null,
        openSeaMetadata: { floorPrice: 0.0582, imageUrl: "https://example.com/col.png", description: "long html" },
      },
      tokenId: "28",
      tokenType: "ERC721",
      name: "DuskBreaker #28",
      description: "Breakers have the honor of serving humanity.",
      image: { cachedUrl: "https://example.com/28.png", originalUrl: "https://duskbreakers.gg/28.png" },
      tokenUri: "https://api.duskbreakers.gg/metadata/28",
      balance: "1",
    }],
    totalCount: 12,
    pageKey: "next-page",
  };
  const stored = formatHoldings(payload, "0xd8da6bf26964af9d7eed9e03e53415d37aa96045", "ethereum");
  assert.equal(
    stored,
    "0xd8da6bf26964af9d7eed9e03e53415d37aa96045  ethereum  total=12\n"
      + "0x0beed7099af7514ccedf642cfea435731176fb02  DUSK  DuskBreakers  "
      + "#28  DuskBreaker #28  ERC721\n"
      + "page=next-page",
  );
  assert.ok(!stored.includes("example.com"));
  assert.ok(!stored.includes("long html"));
  assert.ok(!stored.includes("Breakers have"));
});

test("formatHoldings caps rows and marks spam", () => {
  const payload = {
    ownedNfts: Array.from({ length: 20 }, (_, index) => ({
      contract: { address: `0x${index.toString(16).padStart(40, "0")}`, name: `Col ${index}`, symbol: "X", isSpam: index === 0 },
      tokenId: String(index),
      name: `Token ${index}`,
      balance: index === 1 ? "2" : "1",
    })),
    totalCount: 20,
  };
  const stored = formatHoldings(payload, "0xabc", "base", 3);
  assert.ok(stored.startsWith("0xabc  base  total=20"));
  assert.equal(stored.split("\n").length - 1, 4);
  assert.ok(stored.includes("+17 more"));
  assert.ok(stored.split("\n")[1]?.includes("spam"));
  assert.ok(stored.split("\n")[2]?.includes("bal=2"));
});

test("formatNft and formatCollection keep floor", () => {
  const payload = {
    contract: {
      address: "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d",
      name: "Bored Ape Yacht Club",
      symbol: "BAYC",
      tokenType: "ERC721",
      openSeaMetadata: { floorPrice: 12.5, imageUrl: "https://example.com/x" },
    },
    tokenId: "1",
    name: "Bored Ape #1",
    description: "long",
    image: { cachedUrl: "https://example.com/1.png" },
  };
  const nft = formatNft(payload);
  assert.equal(
    nft,
    "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d  BAYC  Bored Ape Yacht Club  "
      + "#1  Bored Ape #1  ERC721\n"
      + "floor=12.5",
  );
  assert.ok(!nft.includes("example.com"));
  const contract = {
    address: "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d",
    name: "Bored Ape Yacht Club",
    symbol: "BAYC",
    tokenType: "ERC721",
    totalSupply: "10000",
    openseaMetadata: { floorPrice: 12.5, description: "long" },
  };
  const collection = formatCollection(contract);
  assert.equal(
    collection,
    "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d  BAYC  Bored Ape Yacht Club  "
      + "ERC721  supply=10000\n"
      + "floor=12.5",
  );
  assert.ok(!collection.includes("long"));
});

test("holdings uses the NFT path and key", async () => {
  let url = "";
  const stored = await callAlchemy(
    "holdings",
    { owner: "0xd8da", chain: "base" },
    mockFetch((requestUrl) => {
      url = requestUrl;
      return {
        status: 200,
        json: {
          ownedNfts: [{ contract: { address: "0xabc", symbol: "X", name: "Example" }, tokenId: "1", name: "Example #1" }],
          totalCount: 1,
        },
      };
    }),
  );
  assert.equal(
    url,
    "https://base-mainnet.g.alchemy.com/nft/v3/alc-test/getNFTsForOwner?owner=0xd8da&withMetadata=true&pageSize=15",
  );
  assert.equal(stored, "0xd8da  base  total=1\n0xabc  X  Example  #1  Example #1");
});

test("holdings uses ink and robinhood hosts", async () => {
  const seen: string[] = [];
  const client = mockFetch((requestUrl) => {
    seen.push(requestUrl);
    return { status: 200, json: { ownedNfts: [], totalCount: 0 } };
  });
  await callAlchemy("holdings", { owner: "0xabc", chain: "ink" }, client);
  await callAlchemy("holdings", { owner: "0xabc", chain: "robinhood" }, client);
  await callAlchemy("holdings", { owner: "0xabc", chain: "bsc" }, client);
  assert.ok(seen[0]?.startsWith("https://ink-mainnet.g.alchemy.com/nft/v3/alc-test/getNFTsForOwner"));
  assert.ok(seen[1]?.startsWith("https://robinhood-mainnet.g.alchemy.com/nft/v3/alc-test/getNFTsForOwner"));
  assert.ok(seen[2]?.startsWith("https://bnb-mainnet.g.alchemy.com/nft/v3/alc-test/getNFTsForOwner"));
  assert.ok("ink" in CHAINS && "robinhood" in CHAINS && "solana" in CHAINS);
  assert.equal(CHAINS.bsc, "bnb-mainnet");
});

test("holdings solana uses DAS", async () => {
  let url = "";
  let body = "";
  const stored = await callAlchemy(
    "holdings",
    { owner: "So11111111111111111111111111111111111111112", chain: "solana" },
    mockFetch((requestUrl, init) => {
      url = requestUrl;
      body = String(init?.body ?? "");
      return {
        status: 200,
        json: {
          jsonrpc: "2.0",
          id: 1,
          result: {
            total: 1,
            page: 1,
            items: [{
              id: "Mad1111111111111111111111111111111111111111",
              interface: "V1_NFT",
              content: { metadata: { name: "Mad Lads #1", symbol: "MAD" }, links: { image: "https://example.com/1.png" } },
              grouping: [{
                group_key: "collection",
                group_value: "Col1111111111111111111111111111111111111111",
                collection_metadata: { name: "Mad Lads" },
              }],
            }],
          },
        },
      };
    }),
  );
  assert.equal(url, "https://solana-mainnet.g.alchemy.com/v2/alc-test");
  const parsed = JSON.parse(body) as { method: string; params: Record<string, unknown> };
  assert.equal(parsed.method, "getAssetsByOwner");
  assert.equal(parsed.params.ownerAddress, "So11111111111111111111111111111111111111112");
  assert.equal((parsed.params.options as { showFungible?: boolean }).showFungible, false);
  assert.equal(
    stored,
    "So11111111111111111111111111111111111111112  solana  total=1\n"
      + "Col1111111111111111111111111111111111111111  MAD  Mad Lads  "
      + "Mad1111111111111111111111111111111111111111  Mad Lads #1  V1_NFT",
  );
  assert.ok(!stored.includes("example.com"));
});

test("nft solana uses mint", async () => {
  let body = "";
  const stored = await callAlchemy(
    "nft",
    { contract: "Mad1111111111111111111111111111111111111111", chain: "solana" },
    mockFetch((_url, init) => {
      body = String(init?.body ?? "");
      return {
        status: 200,
        json: {
          jsonrpc: "2.0",
          id: 1,
          result: {
            id: "Mad1111111111111111111111111111111111111111",
            interface: "V1_NFT",
            content: { metadata: { name: "Mad Lads #1", symbol: "MAD" } },
          },
        },
      };
    }),
  );
  const parsed = JSON.parse(body) as { method: string; params: { id: string } };
  assert.equal(parsed.method, "getAsset");
  assert.equal(parsed.params.id, "Mad1111111111111111111111111111111111111111");
  assert.equal(stored, "Mad1111111111111111111111111111111111111111  MAD  Mad Lads #1  V1_NFT");
});

test("holdings and nft refuse a body that is not JSON or does not match its schema", async () => {
  const answering = (result: { json?: unknown; text?: string }) => mockFetch(() => ({ status: 200, ...result }));
  await assert.rejects(
    () => callAlchemy("holdings", { owner: "0xd8da", chain: "base" }, answering({ json: { ownedNfts: "none" } })),
    refused(null, /^Alchemy returned an unexpected response at \/ownedNfts: /),
  );
  await assert.rejects(
    () =>
      callAlchemy("holdings", { owner: "0xd8da", chain: "base" }, answering({ json: { ownedNfts: [{ tokenId: 1 }] } })),
    refused(null, /^Alchemy returned an unexpected response at \/ownedNfts\/0\/tokenId: /),
  );
  const mint = "Mad1111111111111111111111111111111111111111";
  await assert.rejects(
    () => callAlchemy("nft", { contract: mint, chain: "solana" }, answering({ json: { result: { id: mint, content: "none" } } })),
    refused(null, /^Alchemy returned an unexpected result at \/content: /),
  );
  await assert.rejects(
    () => callAlchemy("nft", { contract: mint, chain: "solana" }, answering({ json: { error: { code: -32602, message: "bad mint" } } })),
    refused(null, /^bad mint$/),
  );
  await assert.rejects(
    () => callAlchemy("holdings", { owner: "0xd8da", chain: "base" }, answering({ text: "not json" })),
    refused(null, /^Alchemy returned a non-JSON body$/),
  );
});

test("a tool decodes its arguments before it calls Alchemy", async () => {
  const fetched: string[] = [];
  const http = mockFetch((url) => {
    fetched.push(url);
    return { status: 200, json: { ownedNfts: [], totalCount: 0 } };
  });
  assert.equal(
    await callAlchemy("holdings", { owner: "0xabc", contract: " 0xcol ", page_key: "p2", limit: 0 }, http),
    "0xabc  ethereum  total=0",
  );
  await assert.rejects(callAlchemy("holdings", { owner: "0xabc", limit: "3" }, http), refused(422, /^\/limit: /));
  await assert.rejects(callAlchemy("nft", { token_id: "1" }, http), refused(422, /^contract is required$/));
  await assert.rejects(callAlchemy("nft", { contract: "0xabc" }, http), /token_id is required/);
  await assert.rejects(callAlchemy("collection", { contract: "0xabc", chain: "tron" }, http), refused(422, /^\/chain: /));
  await assert.rejects(callAlchemy("holdings", { owner: "0xabc", chain: "BSC" }, http), refused(422, /^\/chain: /));
  assert.deepEqual(fetched, [
    "https://eth-mainnet.g.alchemy.com/nft/v3/alc-test/getNFTsForOwner?owner=0xabc&withMetadata=true&pageSize=1&contractAddresses%5B%5D=0xcol&pageKey=p2",
  ]);
});

test("ping rejects unauthorized", async () => {
  await assert.rejects(
    () => ping("bad", { client: mockFetch(() => ({ status: 401, json: { message: "Must be authenticated!" } })) }),
    (error: unknown) => error instanceof AlchemyError && error.status === 401 && /Must be authenticated/.test(error.message),
  );
});

test("a call to a tool Alchemy does not have is refused", async () => {
  await assert.rejects(() => callAlchemy("swap", {}), refused(404, /^unknown tool swap$/));
});

test("sync Alchemy writes the curated catalog", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  let pinged = 0;
  const pool = new McpPool(new MemoryMcpDatabase(), 10 * 60 * 1000);
  runConnectors(CONNECTORS.withAdapter("alchemy", {
    async validate(creds) {
      const apiKey = creds.token;
      pinged += 1;
      assert.equal(apiKey, "alc-test");
      return "";
    },
  }));
  const [ciphertext, nonce] = encryptPayload({ token: "alc-test" }, KEY);
  const connection = connectionRow({ id: "conn_alc", status: "connected", ciphertext, nonce });
  const server = serverRow("alchemy", { id: "mcp_alchemy", auth: "token" });
  const first = await pool.syncTools(connection, server, { force: true });
  const second = await pool.syncTools(connection, server);
  assert.equal(pinged, 1);
  assert.deepEqual(first.map((tool) => tool.namespaced_name), TOOLS.map((spec) => `alchemy_${spec.name}`));
  assert.deepEqual(first, second);
  assert.deepEqual(first[0], { remote_name: "holdings", namespaced_name: "alchemy_holdings", description: TOOLS[0]!.description, input_schema: TOOLS[0]!.input_schema, read_only_hint: null, destructive_hint: null });
});

test("sync Alchemy rejects a bad key", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const pool = new McpPool(new MemoryMcpDatabase());
  runConnectors(CONNECTORS.withAdapter("alchemy", {
    async validate() {
      throw new ConnectorError("invalid key", 401);
    },
  }));
  const [ciphertext, nonce] = encryptPayload({ token: "bad" }, KEY);
  await assert.rejects(
    () => pool.syncTools(connectionRow({ id: "conn_alc", status: "connected", ciphertext, nonce }), serverRow("alchemy", { id: "mcp_alchemy", auth: "token" }), { force: true }),
    (error: unknown) => error instanceof McpError && error.status === 401,
  );
});

test("call Alchemy dispatches", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const seen: Record<string, unknown> = {};
  const pool = new McpPool(new MemoryMcpDatabase());
  runConnectors(CONNECTORS.withAdapter("alchemy", {
    async call(name, arguments_, creds) {
      seen.name = name;
      seen.arguments = arguments_;
      seen.api_key = creds.token;
      return "0xd8da  ethereum  total=0";
    },
  }));
  const [ciphertext, nonce] = encryptPayload({ token: "alc-test" }, KEY);
  const stored = await pool.call(
    connectionRow({ id: "conn_alc", status: "connected", ciphertext, nonce }),
    serverRow("alchemy", { id: "mcp_alchemy", auth: "token" }),
    { tool: "holdings", arguments: { owner: "0xd8da" }, caller: OPERATOR_CALLER },
  );
  assert.equal(stored, "0xd8da  ethereum  total=0");
  assert.deepEqual(seen, { name: "holdings", arguments: { owner: "0xd8da" }, api_key: "alc-test" });
});
