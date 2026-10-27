import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMasterKey } from "../../src/config/index.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import {
  XError,
  callTool,
  formatPost,
  formatPosts,
  formatSearch,
  formatUser,
  ping,
  postId,
  postsTool,
  searchTool,
} from "../../src/connectors/x/client.js";
import { ListedTool, McpError, McpPool } from "../../src/mcp/index.js";
import { CONNECTORS } from "../../src/connectors/index.js";
import { ConnectorError } from "../../src/connectors/types.js";
import { HEX_MASTER_KEY } from "../helpers/env.js";
import { mockFetch } from "../helpers/http.js";
import { serverRow } from "../helpers/servers.js";
import { connectionRow } from "../helpers/servers.js";

const KEY = decodeMasterKey(HEX_MASTER_KEY);
const TOOLS = CONNECTORS.bySlug("x")!.manifest.tools!;

class MemoryDb {
  rows: Array<Record<string, unknown>> = [];
  async replaceMcpTools(_id: string, tools: ListedTool[]) {
    this.rows = tools.map((tool) => ({ ...tool }));
  }
  async listMcpTools() {
    return this.rows;
  }
}

test("formatSearch is compact TSV", () => {
  const stored = formatSearch(
    {
      data: [{
        id: "123",
        author_id: "44196397",
        created_at: "2026-09-13T12:00:00.000Z",
        text: "hello world",
        public_metrics: { like_count: 12, retweet_count: 3, reply_count: 1, quote_count: 0 },
      }],
      includes: {
        users: [{ id: "44196397", username: "elonmusk", name: "Elon Musk", profile_image_url: "https://example.com/elon.jpg" }],
      },
      meta: { result_count: 1, next_token: "page-2" },
    },
    { query: "from:elonmusk" },
  );
  assert.equal(
    stored,
    "from:elonmusk  n=1\n"
      + "123  @elonmusk  Elon Musk  2026-09-13T12:00:00.000Z  "
      + "likes=12  rts=3  replies=1  quotes=0  hello world\n"
      + "page=page-2",
  );
  assert.ok(!stored.includes("example.com"));
});

test("formatPosts caps rows and clips text", () => {
  const payload = {
    data: Array.from({ length: 20 }, (_, index) => ({
      id: String(index),
      author_id: "1",
      text: "word ".repeat(80).trim(),
      public_metrics: { like_count: index },
    })),
    includes: { users: [{ id: "1", username: "x", name: "X" }] },
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
      username: "elonmusk",
      name: "Elon Musk",
      verified: true,
      verified_type: "blue",
      created_at: "2009-06-02T20:12:29.000Z",
      description: "A long bio with https://example.com/photo",
      profile_image_url: "https://example.com/elon.jpg",
      public_metrics: { followers_count: 200_000_000, following_count: 800, tweet_count: 50_000 },
    },
  });
  assert.equal(
    user,
    "44196397  @elonmusk  Elon Musk  blue  followers=2e+08  "
      + "following=800  posts=50000  2009-06-02T20:12:29.000Z\n"
      + "A long bio with https://example.com/photo",
  );
  assert.ok(!user.includes("elon.jpg"));
  const stored = formatPost({
    data: {
      id: "123",
      author_id: "44196397",
      conversation_id: "100",
      note_tweet: { text: "long form post" },
      text: "short",
      public_metrics: { like_count: 4, retweet_count: 0, reply_count: 2, quote_count: 1 },
    },
    includes: { users: [{ id: "44196397", username: "elonmusk", name: "Elon Musk" }] },
  });
  assert.equal(
    stored,
    "123  @elonmusk  Elon Musk  likes=4  rts=0  replies=2  quotes=1  "
      + "long form post\n"
      + "conversation=100",
  );
});

test("postId accepts URLs", () => {
  assert.equal(postId("1234567890"), "1234567890");
  assert.equal(postId("https://x.com/elonmusk/status/1234567890"), "1234567890");
  assert.equal(postId("https://twitter.com/i/web/status/1234567890?s=20"), "1234567890");
  assert.throws(() => postId("https://x.com/elonmusk"), /post id/);
});

test("search sends a bearer token", async () => {
  let url = "";
  let auth = "";
  const stored = await searchTool(
    { query: "from:x" },
    {
      apiKey: "tok-test",
      client: mockFetch((requestUrl, init) => {
        url = requestUrl;
        const headers = init?.headers as Record<string, string>;
        auth = headers.Authorization ?? headers.authorization ?? "";
        return {
          status: 200,
          json: {
            data: [{ id: "1", author_id: "2", text: "hi" }],
            includes: { users: [{ id: "2", username: "x", name: "X" }] },
            meta: { result_count: 1 },
          },
        };
      }),
    },
  );
  assert.ok(url.startsWith("https://api.x.com/2/tweets/search/recent?"));
  assert.ok(url.includes("query=from%3Ax"));
  assert.equal(auth, "Bearer tok-test");
  assert.equal(stored, "from:x  n=1\n1  @x  X  likes=-  rts=-  replies=-  quotes=-  hi");
});

test("posts resolves username then timeline", async () => {
  const seen: string[] = [];
  const stored = await postsTool(
    { user: "@elonmusk" },
    {
      apiKey: "tok-test",
      client: mockFetch((requestUrl) => {
        seen.push(requestUrl);
        if (requestUrl.includes("/users/by/username/elonmusk")) {
          return { status: 200, json: { data: { id: "44196397", username: "elonmusk", name: "Elon Musk" } } };
        }
        return {
          status: 200,
          json: { data: [{ id: "9", author_id: "44196397", text: "post" }], meta: { result_count: 1 } },
        };
      }),
    },
  );
  assert.ok(seen[0]?.startsWith("https://api.x.com/2/users/by/username/elonmusk"));
  assert.ok(seen[1]?.startsWith("https://api.x.com/2/users/44196397/tweets"));
  assert.equal(stored, "9  @elonmusk  Elon Musk  likes=-  rts=-  replies=-  quotes=-  post");
});

test("ping rejects unauthorized", async () => {
  await assert.rejects(
    () => ping("bad", { client: mockFetch(() => ({ status: 401, json: { detail: "Unauthorized", title: "Unauthorized" } })) }),
    (error: unknown) => error instanceof XError && error.status === 401 && /Unauthorized/.test(error.message),
  );
});

test("callTool unknown name", async () => {
  await assert.rejects(() => callTool("tweet", {}, { apiKey: "tok-test" }), /unknown X tool/);
});

test("sync X writes the curated catalog", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  let pinged = 0;
  const pool = new McpPool(10 * 60 * 1000);
  pool.connectors = CONNECTORS.withAdapter("x", {
    async validate(creds) {
      const apiKey = creds.token;
      pinged += 1;
      assert.equal(apiKey, "tok-test");
      return "";
    },
  });
  const [ciphertext, nonce] = encryptPayload({ token: "tok-test" }, KEY);
  const db = new MemoryDb();
  const connection = connectionRow({ id: "conn_x", status: "connected", ciphertext, nonce });
  const server = serverRow("x", { id: "mcp_x", auth: "token" });
  const first = await pool.syncTools(db as never, connection, server, { force: true });
  const second = await pool.syncTools(db as never, connection, server);
  assert.equal(pinged, 1);
  assert.deepEqual(first.map((tool) => tool.namespaced_name), TOOLS.map((spec) => `x_${spec.name}`));
  assert.deepEqual(first, second);
  assert.deepEqual(first[0], new ListedTool("search", "x_search", TOOLS[0]!.description, TOOLS[0]!.input_schema));
});

test("sync X rejects a bad key", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const pool = new McpPool();
  pool.connectors = CONNECTORS.withAdapter("x", {
    async validate() {
      throw new ConnectorError("Unauthorized", 401);
    },
  });
  const [ciphertext, nonce] = encryptPayload({ token: "bad" }, KEY);
  await assert.rejects(
    () => pool.syncTools(new MemoryDb() as never, connectionRow({ id: "conn_x", status: "connected", ciphertext, nonce }), serverRow("x", { id: "mcp_x", auth: "token" }), { force: true }),
    (error: unknown) => error instanceof McpError && error.status === 401,
  );
});

test("call X dispatches", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const seen: Record<string, unknown> = {};
  const pool = new McpPool();
  pool.connectors = CONNECTORS.withAdapter("x", {
    async call(name, arguments_, creds) {
      seen.name = name;
      seen.arguments = arguments_;
      seen.api_key = creds.token;
      return "from:x  n=0";
    },
  });
  const [ciphertext, nonce] = encryptPayload({ token: "tok-test" }, KEY);
  const stored = await pool.call(
    new MemoryDb() as never,
    connectionRow({ id: "conn_x", status: "connected", ciphertext, nonce }),
    serverRow("x", { id: "mcp_x", auth: "token" }),
    "search",
    { query: "from:x" },
  );
  assert.equal(stored, "from:x  n=0");
  assert.deepEqual(seen, { name: "search", arguments: { query: "from:x" }, api_key: "tok-test" });
});
