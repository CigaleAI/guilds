import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMasterKey } from "../../src/config/index.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import {
  AlchemyError,
  CHAINS,
  callTool,
  formatCollection,
  formatHoldings,
  formatNft,
  holdingsTool,
  nftTool,
  ping,
} from "../../src/connectors/alchemy/client.js";
import { McpError } from "../../src/mcp/errors.js";
import { McpPool, OPERATOR_CALLER } from "../../src/mcp/pool.js";
import { CONNECTORS } from "../../src/connectors/index.js";
import { ConnectorError } from "../../src/connectors/types.js";
import { HEX_MASTER_KEY } from "../helpers/env.js";
import { mockFetch } from "../helpers/http.js";
import { serverRow } from "../helpers/servers.js";
import { connectionRow } from "../helpers/servers.js";
import { MemoryMcpDatabase } from "../helpers/mcp-database.js";
import { restoreConnectorsAfterEach, runConnectors } from "../helpers/installed.js";

restoreConnectorsAfterEach();

const KEY = decodeMasterKey(HEX_MASTER_KEY);
const TOOLS = CONNECTORS.bySlug("alchemy")!.manifest.tools!;


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
  const stored = await holdingsTool(
    { owner: "0xd8da", chain: "base" },
    {
      apiKey: "alc-test",
      client: mockFetch((requestUrl) => {
        url = requestUrl;
        return {
          status: 200,
          json: {
            ownedNfts: [{ contract: { address: "0xabc", symbol: "X", name: "Example" }, tokenId: "1", name: "Example #1" }],
            totalCount: 1,
          },
        };
      }),
    },
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
  await holdingsTool({ owner: "0xabc", chain: "ink" }, { apiKey: "alc-test", client });
  await holdingsTool({ owner: "0xabc", chain: "robinhood" }, { apiKey: "alc-test", client });
  await holdingsTool({ owner: "0xabc", chain: "bsc" }, { apiKey: "alc-test", client });
  assert.ok(seen[0]?.startsWith("https://ink-mainnet.g.alchemy.com/nft/v3/alc-test/getNFTsForOwner"));
  assert.ok(seen[1]?.startsWith("https://robinhood-mainnet.g.alchemy.com/nft/v3/alc-test/getNFTsForOwner"));
  assert.ok(seen[2]?.startsWith("https://bnb-mainnet.g.alchemy.com/nft/v3/alc-test/getNFTsForOwner"));
  assert.ok("ink" in CHAINS && "robinhood" in CHAINS && "solana" in CHAINS);
  assert.equal(CHAINS.bsc, "bnb-mainnet");
});

test("holdings solana uses DAS", async () => {
  let url = "";
  let body = "";
  const stored = await holdingsTool(
    { owner: "So11111111111111111111111111111111111111112", chain: "solana" },
    {
      apiKey: "alc-test",
      client: mockFetch((requestUrl, init) => {
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
    },
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
  const stored = await nftTool(
    { contract: "Mad1111111111111111111111111111111111111111", chain: "solana" },
    {
      apiKey: "alc-test",
      client: mockFetch((_url, init) => {
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
    },
  );
  const parsed = JSON.parse(body) as { method: string; params: { id: string } };
  assert.equal(parsed.method, "getAsset");
  assert.equal(parsed.params.id, "Mad1111111111111111111111111111111111111111");
  assert.equal(stored, "Mad1111111111111111111111111111111111111111  MAD  Mad Lads #1  V1_NFT");
});

test("holdings and nft refuse a body that is not JSON or does not match its schema", async () => {
  const answering = (result: { json?: unknown; text?: string }) => ({
    apiKey: "alc-test",
    client: mockFetch(() => ({ status: 200, ...result })),
  });
  const unexpectedAt = (path: string) => (error: unknown) =>
    error instanceof AlchemyError &&
    error.message.startsWith(`Alchemy returned an unexpected response at ${path}: `);
  await assert.rejects(
    () =>
      holdingsTool({ owner: "0xd8da", chain: "base" }, answering({ json: { ownedNfts: "none" } })),
    unexpectedAt("/ownedNfts"),
  );
  const mint = "Mad1111111111111111111111111111111111111111";
  await assert.rejects(
    () =>
      nftTool(
        { contract: mint, chain: "solana" },
        answering({ json: { result: { id: mint, content: "none" } } }),
      ),
    unexpectedAt("/content"),
  );
  await assert.rejects(
    () => holdingsTool({ owner: "0xd8da", chain: "base" }, answering({ text: "not json" })),
    (error: unknown) =>
      error instanceof AlchemyError && error.message === "Alchemy returned a non-JSON body",
  );
});

test("ping rejects unauthorized", async () => {
  await assert.rejects(
    () => ping("bad", { client: mockFetch(() => ({ status: 401, json: { message: "Must be authenticated!" } })) }),
    (error: unknown) => error instanceof AlchemyError && error.status === 401 && /Must be authenticated/.test(error.message),
  );
});

test("callTool unknown name", async () => {
  await assert.rejects(() => callTool("swap", {}, { apiKey: "alc-test" }), /unknown Alchemy tool/);
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
