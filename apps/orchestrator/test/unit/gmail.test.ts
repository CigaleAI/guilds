import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMasterKey } from "../../src/config/index.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import { clipText } from "../../src/connectors/format.js";
import {
  GmailError,
  callTool,
  decodeBodyData,
  headerMap,
  messageBody,
  ping,
  rfc2822Raw,
  stripTags,
} from "../../src/connectors/gmail/client.js";
import { ListedTool, McpDisconnectedError, McpPool } from "../../src/mcp/index.js";
import { CONNECTORS } from "../../src/connectors/index.js";
import { HEX_MASTER_KEY } from "../helpers/env.js";
import { mockFetch } from "../helpers/http.js";

const KEY = decodeMasterKey(HEX_MASTER_KEY);
const TOOLS = CONNECTORS.bySlug("gmail")!.manifest.tools!;
const TOKEN = "ya29.gmail-test";

class MemoryDb {
  rows: Array<Record<string, unknown>> = [];
  async replaceMcpTools(_id: string, tools: ListedTool[]) {
    this.rows = tools.map((tool) => ({ ...tool }));
  }
  async listMcpTools() {
    return this.rows;
  }
}

function payload(headers: Array<{ name: string; value: string }>, text: string) {
  return {
    mimeType: "text/plain",
    headers,
    body: { data: Buffer.from(text).toString("base64url") },
  };
}

test("headerMap, decode, strip, and clip", () => {
  assert.deepEqual(
    headerMap([
      { name: "From", value: "Ada <ada@example.com>" },
      { name: "from", value: "ignored" },
    ]),
    { from: "Ada <ada@example.com>" },
  );
  assert.equal(decodeBodyData(Buffer.from("hello").toString("base64url")), "hello");
  assert.equal(stripTags("<p>Hi&nbsp;<b>Ada</b></p>"), "Hi Ada");
  assert.equal(clipText("word ".repeat(20), 12).endsWith("…"), true);
});

test("messageBody prefers plain text and clips html", () => {
  assert.equal(
    messageBody({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: Buffer.from("<p>html</p>").toString("base64url") } },
        { mimeType: "text/plain", body: { data: Buffer.from("plain").toString("base64url") } },
      ],
    }),
    "plain",
  );
  assert.equal(
    messageBody({
      mimeType: "text/html",
      body: { data: Buffer.from("<p>only html</p>").toString("base64url") },
    }),
    "only html",
  );
});

test("rfc2822Raw encodes subject and optional copies", () => {
  const raw = rfc2822Raw({
    to: "ada@example.com",
    cc: "cc@example.com",
    subject: "Café",
    body: "hello",
  });
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  assert.match(decoded, /^To: ada@example.com\r\n/);
  assert.match(decoded, /Cc: cc@example.com/);
  assert.match(decoded, /Subject: =\?UTF-8\?B\?/);
  assert.match(decoded, /\r\n\r\nhello$/);
});

test("search_threads lists metadata and page tokens", async () => {
  const stored = await callTool(
    "search_threads",
    { query: "from:ada", limit: 10 },
    {
      accessToken: TOKEN,
      client: mockFetch((url) => {
        if (url.includes("/threads?") && url.includes("q=from%3Aada")) {
          return {
            status: 200,
            json: {
              threads: [{ id: "t1" }],
              resultSizeEstimate: 1,
              nextPageToken: "page-2",
            },
          };
        }
        if (url.includes("/threads/t1")) {
          assert.ok(url.includes("metadataHeaders=From"));
          return {
            status: 200,
            json: {
              id: "t1",
              messages: [
                {
                  id: "m1",
                  snippet: "hello there",
                  payload: payload(
                    [
                      { name: "From", value: "Ada" },
                      { name: "Subject", value: "Hi" },
                      { name: "Date", value: "Thu, 1 Oct 2026" },
                    ],
                    "unused",
                  ),
                },
              ],
            },
          };
        }
        return { status: 404, json: { error: { message: url } } };
      }),
    },
  );
  assert.equal(stored, "from:ada  n=1\nt1  Ada  Hi  Thu, 1 Oct 2026  hello there\npage=page-2");
});

test("get_thread and get_message render bodies", async () => {
  const thread = await callTool(
    "get_thread",
    { thread_id: "t1" },
    {
      accessToken: TOKEN,
      client: mockFetch((url) => {
        assert.ok(url.includes("/threads/t1"));
        return {
          status: 200,
          json: {
            id: "t1",
            messages: [
              {
                id: "m1",
                payload: payload([{ name: "From", value: "Ada" }, { name: "Subject", value: "Hi" }], "first"),
              },
              {
                id: "m2",
                payload: payload([{ name: "From", value: "me" }], "second"),
              },
            ],
          },
        };
      }),
    },
  );
  assert.equal(thread, "t1  messages=2\n---\nm1  Ada  Hi\nfirst\n---\nm2  me\nsecond");
  const message = await callTool(
    "get_message",
    { message_id: "m1" },
    {
      accessToken: TOKEN,
      client: mockFetch(() => ({
        status: 200,
        json: {
          id: "m1",
          payload: payload([{ name: "From", value: "Ada" }, { name: "Subject", value: "Hi" }], "body"),
        },
      })),
    },
  );
  assert.equal(message, "m1  Ada  Hi\nbody");
});

test("list_labels and list_drafts", async () => {
  const labels = await callTool(
    "list_labels",
    {},
    {
      accessToken: TOKEN,
      client: mockFetch(() => ({
        status: 200,
        json: { labels: [{ id: "INBOX", name: "INBOX", type: "system" }] },
      })),
    },
  );
  assert.equal(labels, "INBOX  INBOX  system");
  const drafts = await callTool(
    "list_drafts",
    {},
    {
      accessToken: TOKEN,
      client: mockFetch((url) => {
        if (url.includes("/drafts?") || url.endsWith("/drafts")) {
          return { status: 200, json: { drafts: [{ id: "d1" }] } };
        }
        return {
          status: 200,
          json: {
            id: "d1",
            message: {
              id: "m9",
              payload: payload([{ name: "To", value: "ada@example.com" }, { name: "Subject", value: "Draft" }], ""),
            },
          },
        };
      }),
    },
  );
  assert.equal(drafts, "d1  m9  ada@example.com  Draft");
});

test("create_draft and send_message post raw RFC2822", async () => {
  let draftRaw = "";
  let sendRaw = "";
  const draft = await callTool(
    "create_draft",
    { to: "ada@example.com", subject: "Hi", body: "hello" },
    {
      accessToken: TOKEN,
      client: mockFetch((_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { message?: { raw?: string } };
        draftRaw = body.message?.raw ?? "";
        return { status: 200, json: { id: "d1", message: { id: "m1" } } };
      }),
    },
  );
  assert.equal(draft, "draft=d1  message=m1");
  assert.match(Buffer.from(draftRaw, "base64url").toString("utf8"), /To: ada@example.com/);
  const sent = await callTool(
    "send_message",
    { to: "ada@example.com", subject: "Hi", body: "hello" },
    {
      accessToken: TOKEN,
      client: mockFetch((_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { raw?: string };
        sendRaw = body.raw ?? "";
        return { status: 200, json: { id: "m2", threadId: "t2" } };
      }),
    },
  );
  assert.equal(sent, "id=m2  thread=t2");
  assert.ok(sendRaw);
});

test("Gmail errors surface provider messages", async () => {
  await assert.rejects(
    () =>
      ping(TOKEN, {
        client: mockFetch(() => ({ status: 401, json: { error: { message: "Invalid Credentials" } } })),
      }),
    (error: unknown) => error instanceof GmailError && error.status === 401 && /Invalid Credentials/.test(error.message),
  );
  await assert.rejects(() => callTool("nope", {}, { accessToken: TOKEN }), /unknown Gmail tool/);
  await assert.rejects(() => callTool("search_threads", {}, { accessToken: TOKEN }), /query is required/);
});

test("sync Gmail writes the curated catalog", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  let pinged = 0;
  const pool = new McpPool(10 * 60 * 1000);
  pool.connectors = CONNECTORS.withAdapter("gmail", {
    async validate(creds) {
      const accessToken = creds.access_token;
      pinged += 1;
      assert.equal(accessToken, TOKEN);
      return "ada@example.com";
    },
  });
  const [ciphertext, nonce] = encryptPayload({ access_token: TOKEN }, KEY);
  const db = new MemoryDb();
  const connection = { id: "conn_gmail", status: "connected", ciphertext, nonce };
  const server = { id: "mcp_gmail", slug: "gmail", auth: "oauth", config: { url: "https://gmail.googleapis.com/gmail/v1" } };
  const first = await pool.syncTools(db, connection, server, { force: true });
  const second = await pool.syncTools(db, connection, server);
  assert.equal(pinged, 1);
  assert.deepEqual(
    first.map((tool) => tool.namespaced_name),
    TOOLS.map((spec) => `gmail_${spec.name}`),
  );
  assert.deepEqual(first, second);
  assert.deepEqual(
    first[0],
    new ListedTool("search_threads", "gmail_search_threads", TOOLS[0]!.description, TOOLS[0]!.input_schema),
  );
});

test("call Gmail dispatches with the stored access token", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const seen: Record<string, unknown> = {};
  const pool = new McpPool();
  pool.connectors = CONNECTORS.withAdapter("gmail", {
    async call(name, arguments_, creds) {
      seen.name = name;
      seen.arguments = arguments_;
      seen.token = creds.access_token;
      return "from:ada  n=0";
    },
  });
  const [ciphertext, nonce] = encryptPayload({ access_token: TOKEN }, KEY);
  const stored = await pool.call(
    new MemoryDb(),
    { id: "conn_gmail", status: "connected", ciphertext, nonce },
    { id: "mcp_gmail", slug: "gmail", auth: "oauth" },
    "search_threads",
    { query: "from:ada" },
  );
  assert.equal(stored, "from:ada  n=0");
  assert.deepEqual(seen, { name: "search_threads", arguments: { query: "from:ada" }, token: TOKEN });
});

test("sync Gmail disconnects a login with no token to refresh", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const [ciphertext, nonce] = encryptPayload({}, KEY);
  const saved: string[] = [];
  const db = Object.assign(new MemoryDb(), {
    async saveMcpConnection(_id: string, options: { status: string }) {
      saved.push(options.status);
      return null;
    },
  });
  await assert.rejects(
    () =>
      new McpPool().syncTools(
        db,
        { id: "conn_gmail", status: "connected", ciphertext, nonce },
        { id: "mcp_gmail", slug: "gmail", auth: "oauth" },
        { force: true },
      ),
    (error: unknown) => error instanceof McpDisconnectedError,
  );
  assert.deepEqual(saved, ["disconnected"]);
});
