import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMasterKey } from "../../src/config/index.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import {
  SEARCH_QUERY_TYPE,
  SEARCH_WINDOW,
  TwitterApiIoError,
  callTool,
  constrainSearchQuery,
  formatPost,
  formatPosts,
  formatSearch,
  formatTrends,
  formatUser,
  formatUsers,
  ping,
  postId,
  postsTool,
  searchTool,
} from "../../src/connectors/twitterapiio/client.js";
import { McpError } from "../../src/mcp/errors.js";
import { McpPool, OPERATOR_CALLER } from "../../src/mcp/pool.js";
import { CONNECTORS } from "../../src/connectors/index.js";
import { ConnectorError } from "../../src/connectors/types.js";
import { HEX_MASTER_KEY } from "../helpers/env.js";
import { loadJsonFixture } from "../helpers/fixtures.js";
import { mockFetch } from "../helpers/http.js";
import { serverRow } from "../helpers/servers.js";
import { connectionRow } from "../helpers/servers.js";
import { MemoryMcpDatabase } from "../helpers/mcp-database.js";
import { restoreConnectorsAfterEach, runConnectors } from "../helpers/installed.js";

restoreConnectorsAfterEach();

const fixture = loadJsonFixture<{
  search: string;
  user: string;
  posts: string;
  post: string;
  followers: string;
  trends: string;
}>("adapters/twitterapiio.json");
const KEY = decodeMasterKey(HEX_MASTER_KEY);
const TOOLS = CONNECTORS.bySlug("twitterapiio")!.manifest.tools!;


test("formatSearch is compact TSV", () => {
  const stored = formatSearch(
    {
      tweets: [{
        id: "123",
        createdAt: "2026-09-13T12:00:00.000Z",
        text: "hello world",
        likeCount: 12,
        retweetCount: 3,
        replyCount: 1,
        quoteCount: 0,
        author: {
          id: "44196397",
          userName: "elonmusk",
          name: "Elon Musk",
          profilePicture: "https://example.com/elon.jpg",
        },
      }],
      has_next_page: true,
      next_cursor: "page-2",
    },
    { query: "from:elonmusk" },
  );
  assert.equal(stored, fixture.search);
  assert.ok(!stored.includes("example.com"));
});

test("formatPosts caps rows and clips text", () => {
  const payload = {
    data: {
      tweets: Array.from({ length: 20 }, (_, index) => ({
        id: String(index),
        text: "word ".repeat(80).trim(),
        likeCount: index,
        author: { userName: "x", name: "X" },
      })),
    },
  };
  const stored = formatPosts(payload, { limit: 3 });
  const lines = stored.split("\n");
  assert.equal(lines.length, 4);
  assert.equal(lines.at(-1), "+17 more");
  assert.ok(lines[0]?.includes("…"));
  assert.ok(!stored.includes("word ".repeat(80)));
});

test("formatUser and formatPost keep metrics", () => {
  const user = formatUser({
    data: {
      id: "44196397",
      userName: "elonmusk",
      name: "Elon Musk",
      isBlueVerified: true,
      verifiedType: "blue",
      createdAt: "2026-09-13T12:00:00.000Z",
      description: "bio",
      profilePicture: "https://example.com/elon.jpg",
      followers: 1,
      following: 2,
      statusesCount: 3,
    },
  });
  assert.equal(user, fixture.user);
  assert.ok(!user.includes("elon.jpg"));
  const stored = formatPost({
    tweets: [{
      id: "1",
      text: "one",
      likeCount: 1,
      author: { userName: "x", name: "X" },
    }],
  });
  assert.equal(stored, fixture.post);
});

test("formatUsers and formatTrends keep compact rows", () => {
  assert.equal(
    formatUsers({
      followers: [{ id: "2", userName: "alice", name: "Alice", followers: 10, following: 4 }],
    }, "followers"),
    fixture.followers,
  );
  assert.equal(formatTrends({ data: [{ name: "#AI", tweetCount: 12345 }] }), fixture.trends);
});

test("constrainSearchQuery pins Top window", () => {
  assert.equal(constrainSearchQuery("from:x"), `from:x ${SEARCH_WINDOW}`);
  assert.equal(constrainSearchQuery("AI since:2020-01-01 until:2020-02-01"), `AI ${SEARCH_WINDOW}`);
  assert.equal(constrainSearchQuery("AI within_time:7d"), `AI ${SEARCH_WINDOW}`);
  assert.equal(constrainSearchQuery(`AI ${SEARCH_WINDOW}`), `AI ${SEARCH_WINDOW}`);
  assert.throws(() => constrainSearchQuery(""), /query is required/);
  assert.throws(() => constrainSearchQuery("since:2020-01-01"), /query is required/);
});

test("postId accepts URLs", () => {
  assert.equal(postId("1234567890"), "1234567890");
  assert.equal(postId("https://x.com/elonmusk/status/1234567890"), "1234567890");
  assert.equal(postId("https://twitter.com/i/web/status/1234567890?s=20"), "1234567890");
  assert.throws(() => postId("https://x.com/elonmusk"), /post id/);
});

test("search sends x-api-key", async () => {
  let url = "";
  let auth = "";
  const stored = await searchTool(
    { query: "from:x since:2020-01-01", sort: "Latest" },
    {
      apiKey: "tok-test",
      client: mockFetch((requestUrl, init) => {
        url = requestUrl;
        const headers = init?.headers as Record<string, string>;
        auth = headers["x-api-key"] ?? headers["X-API-Key"] ?? "";
        return {
          status: 200,
          json: {
            tweets: [{ id: "1", text: "hi", author: { userName: "x", name: "X" } }],
          },
        };
      }),
    },
  );
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, "https://api.twitterapi.io/twitter/tweet/advanced_search");
  assert.equal(parsed.searchParams.get("query"), `from:x ${SEARCH_WINDOW}`);
  assert.equal(parsed.searchParams.get("queryType"), SEARCH_QUERY_TYPE);
  assert.equal(auth, "tok-test");
  assert.equal(stored, `from:x ${SEARCH_WINDOW}  n=1\n1  @x  X  likes=-  rts=-  replies=-  quotes=-  hi`);
});

test("search refuses a body that is not JSON or does not match its schema", async () => {
  const answering = (result: { json?: unknown; text?: string }) => ({
    apiKey: "tok-test",
    client: mockFetch(() => ({ status: 200, ...result })),
  });
  await assert.rejects(
    () => searchTool({ query: "from:x" }, answering({ json: { tweets: "none" } })),
    (error: unknown) =>
      error instanceof TwitterApiIoError &&
      /^TwitterAPI.io returned an unexpected response at \/tweets: /.test(error.message),
  );
  await assert.rejects(
    () => searchTool({ query: "from:x" }, answering({ text: "not json" })),
    (error: unknown) =>
      error instanceof TwitterApiIoError &&
      error.message === "TwitterAPI.io returned a non-JSON body",
  );
});

test("posts resolves username then last tweets", async () => {
  let url = "";
  const stored = await postsTool(
    { user: "@elonmusk" },
    {
      apiKey: "tok-test",
      client: mockFetch((requestUrl) => {
        url = requestUrl;
        return {
          status: 200,
          json: {
            data: { tweets: [{ id: "9", text: "post", author: { userName: "elonmusk", name: "Elon Musk" } }] },
          },
        };
      }),
    },
  );
  assert.ok(url.startsWith("https://api.twitterapi.io/twitter/user/last_tweets?"));
  assert.ok(url.includes("userName=elonmusk"));
  assert.equal(stored, "9  @elonmusk  Elon Musk  likes=-  rts=-  replies=-  quotes=-  post");
});

test("ping rejects unauthorized", async () => {
  await assert.rejects(
    () => ping("bad", { client: mockFetch(() => ({ status: 401, json: { detail: "Unauthorized" } })) }),
    (error: unknown) => error instanceof TwitterApiIoError && error.status === 401 && /Unauthorized/.test(error.message),
  );
});

test("callTool unknown name", async () => {
  await assert.rejects(() => callTool("tweet", {}, { apiKey: "tok-test" }), /unknown TwitterAPI.io tool/);
});

test("sync TwitterAPI.io writes the curated catalog", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  let pinged = 0;
  const pool = new McpPool(new MemoryMcpDatabase(), 10 * 60 * 1000);
  runConnectors(CONNECTORS.withAdapter("twitterapiio", {
    async validate(creds) {
      const apiKey = creds.token;
      pinged += 1;
      assert.equal(apiKey, "tok-test");
      return "";
    },
  }));
  const [ciphertext, nonce] = encryptPayload({ token: "tok-test" }, KEY);
  const connection = connectionRow({ id: "conn_twitterapiio", status: "connected", ciphertext, nonce });
  const server = serverRow("twitterapiio", { id: "mcp_twitterapiio", auth: "token" });
  const first = await pool.syncTools(connection, server, { force: true });
  const second = await pool.syncTools(connection, server);
  assert.equal(pinged, 1);
  assert.deepEqual(first.map((tool) => tool.namespaced_name), TOOLS.map((spec) => `twitterapiio_${spec.name}`));
  assert.deepEqual(first, second);
  assert.deepEqual(first[0], { remote_name: "search", namespaced_name: "twitterapiio_search", description: TOOLS[0]!.description, input_schema: TOOLS[0]!.input_schema, read_only_hint: null, destructive_hint: null });
  assert.ok(!("sort" in (TOOLS[0]!.input_schema.properties as Record<string, unknown>)));
});

test("sync TwitterAPI.io rejects a bad key", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const pool = new McpPool(new MemoryMcpDatabase());
  runConnectors(CONNECTORS.withAdapter("twitterapiio", {
    async validate() {
      throw new ConnectorError("Unauthorized", 401);
    },
  }));
  const [ciphertext, nonce] = encryptPayload({ token: "bad" }, KEY);
  await assert.rejects(
    () =>
      pool.syncTools(
        connectionRow({ id: "conn_twitterapiio", status: "connected", ciphertext, nonce }),
        serverRow("twitterapiio", { id: "mcp_twitterapiio", auth: "token" }),
        { force: true },
      ),
    (error: unknown) => error instanceof McpError && error.status === 401,
  );
});

test("call TwitterAPI.io dispatches", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const seen: Record<string, unknown> = {};
  const pool = new McpPool(new MemoryMcpDatabase());
  runConnectors(CONNECTORS.withAdapter("twitterapiio", {
    async call(name, arguments_, creds) {
      seen.name = name;
      seen.arguments = arguments_;
      seen.api_key = creds.token;
      return "from:x  n=0";
    },
  }));
  const [ciphertext, nonce] = encryptPayload({ token: "tok-test" }, KEY);
  const stored = await pool.call(
    connectionRow({ id: "conn_twitterapiio", status: "connected", ciphertext, nonce }),
    serverRow("twitterapiio", { id: "mcp_twitterapiio", auth: "token" }),
    { tool: "search", arguments: { query: "from:x" }, caller: OPERATOR_CALLER },
  );
  assert.equal(stored, "from:x  n=0");
  assert.deepEqual(seen, { name: "search", arguments: { query: "from:x" }, api_key: "tok-test" });
});
