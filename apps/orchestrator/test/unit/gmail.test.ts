import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { decodeMasterKey } from "../../src/config/index.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import { clipText } from "../../src/connectors/format.js";
import gmailAdapter from "../../src/connectors/gmail/adapter.js";
import { ConnectorError, type ConnectorContext } from "../../src/connectors/types.js";
import {
  ATTACHMENT_CAP,
  GmailError,
  attachmentFileName,
  callTool,
  decodeBodyData,
  headerMap,
  messageAttachments,
  messageBody,
  ping,
  rfc2822Raw,
  stripTags,
} from "../../src/connectors/gmail/client.js";
import { ListedTool, McpDisconnectedError, McpPool, OPERATOR_CALLER } from "../../src/mcp/index.js";
import { CONNECTORS } from "../../src/connectors/index.js";
import { HEX_MASTER_KEY } from "../helpers/env.js";
import { mockFetch } from "../helpers/http.js";
import { serverRow } from "../helpers/servers.js";
import { connectionRow } from "../helpers/servers.js";
import { MemoryMcpDatabase } from "../helpers/mcp-database.js";

const KEY = decodeMasterKey(HEX_MASTER_KEY);
const TOOLS = CONNECTORS.bySlug("gmail")!.manifest.tools!;
const TOKEN = "ya29.gmail-test";


function payload(headers: Array<{ name: string; value: string }>, text: string) {
  return {
    mimeType: "text/plain",
    headers,
    body: { data: Buffer.from(text).toString("base64url") },
  };
}

/** A temporary host directory named after agent a_1, as its home sits on its machine. */
async function agentWorkspace(prefix: string): Promise<string> {
  const workspace = path.join(await mkdtemp(path.join(os.tmpdir(), prefix)), "a_1");
  await mkdir(workspace);
  return workspace;
}

/** A message with a text body, a fetched PDF attachment at part 1, and an inline text attachment at part 2. */
function messageWithAttachments(pdfSize = 3) {
  return {
    id: "m1",
    payload: {
      mimeType: "multipart/mixed",
      headers: [{ name: "From", value: "Ada" }, { name: "Subject", value: "Invoice" }],
      parts: [
        { partId: "0", mimeType: "text/plain", filename: "", body: { data: Buffer.from("see attached").toString("base64url") } },
        { partId: "1", mimeType: "application/pdf", filename: "invoice.pdf", body: { attachmentId: "att-1", size: pdfSize } },
        { partId: "2", mimeType: "text/plain", filename: "notes.txt", body: { data: Buffer.from("inline").toString("base64url"), size: 6 } },
      ],
    },
  };
}

/** Gmail answering the message above, and the PDF's bytes by its attachment id. */
function attachmentsFetch(message: Record<string, unknown> = messageWithAttachments()) {
  return mockFetch((url) => {
    if (url.includes("/messages/m1/attachments/att-1")) {
      return { status: 200, json: { size: 3, data: Buffer.from("PDF").toString("base64url") } };
    }
    if (url.includes("/messages/m1?")) {
      return { status: 200, json: message };
    }
    return { status: 404, json: { error: { message: url } } };
  });
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

test("messageBody leaves out the text of attachments", () => {
  assert.equal(messageBody(messageWithAttachments().payload), "see attached");
});

test("messageAttachments lists every part with a filename", () => {
  assert.deepEqual(
    messageAttachments(messageWithAttachments().payload).map((item) => [item.partId, item.filename, item.size]),
    [
      ["1", "invoice.pdf", 3],
      ["2", "notes.txt", 6],
    ],
  );
  assert.deepEqual(messageAttachments(null), []);
});

test("attachmentFileName keeps the name to one segment of the workspace root", () => {
  const named = (filename: string) =>
    attachmentFileName({ partId: "3", filename, mimeType: "", size: 0, attachmentId: "", data: "" });
  assert.equal(named("../../etc/passwd"), "-..-etc-passwd");
  assert.equal(named("a\\b\nc.pdf"), "a-b-c.pdf");
  assert.equal(named("..."), "attachment-3");
  assert.equal(named("x".repeat(300)).length, 200);
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

test("get_message lists attachments between the headers and the body", async () => {
  const message = await callTool("get_message", { message_id: "m1" }, { accessToken: TOKEN, client: attachmentsFetch() });
  assert.equal(
    message,
    [
      "m1  Ada  Invoice",
      "attachment  part=1  invoice.pdf  application/pdf  bytes=3",
      "attachment  part=2  notes.txt  text/plain  bytes=6",
      "see attached",
    ].join("\n"),
  );
});

test("download_attachment fetches an attachment by id and writes it under the workspace", async () => {
  const workspace = await agentWorkspace("gmail-download-");
  const saved = await callTool(
    "download_attachment",
    { message_id: "m1", part_id: "1" },
    { accessToken: TOKEN, client: attachmentsFetch(), workspaceDir: workspace },
  );
  assert.equal(saved, "file_path=/home/a_1/invoice.pdf  application/pdf  bytes=3");
  assert.equal(await readFile(path.join(workspace, "invoice.pdf"), "utf8"), "PDF");
});

test("download_attachment writes inline attachment data to the requested file_path", async () => {
  const workspace = await agentWorkspace("gmail-download-");
  const saved = await callTool(
    "download_attachment",
    { message_id: "m1", part_id: "2", file_path: "/home/a_1/mail/notes.txt" },
    { accessToken: TOKEN, client: attachmentsFetch(), workspaceDir: workspace },
  );
  assert.equal(saved, "file_path=/home/a_1/mail/notes.txt  text/plain  bytes=6");
  assert.equal(await readFile(path.join(workspace, "mail", "notes.txt"), "utf8"), "inline");
});

test("download_attachment refuses calls it cannot serve", async () => {
  const workspace = await agentWorkspace("gmail-download-");
  const options = { accessToken: TOKEN, client: attachmentsFetch(), workspaceDir: workspace };
  const refused = (status: number, pattern: RegExp) => (error: unknown) =>
    error instanceof GmailError && error.status === status && pattern.test(error.message);
  await assert.rejects(
    () => callTool("download_attachment", { message_id: "m1", part_id: "1" }, { accessToken: TOKEN, client: attachmentsFetch() }),
    refused(422, /only available during an agent run/),
  );
  await assert.rejects(() => callTool("download_attachment", { message_id: "m1" }, options), /part_id is required/);
  await assert.rejects(() => callTool("download_attachment", { part_id: "1" }, options), /message_id is required/);
  await assert.rejects(
    () => callTool("download_attachment", { message_id: "m1", part_id: "0" }, options),
    refused(422, /no attachment at part 0/),
  );
  await assert.rejects(
    () => callTool("download_attachment", { message_id: "m1", part_id: "1", file_path: "/etc/invoice.pdf" }, options),
    refused(422, /must be under \/home\/a_1/),
  );
  const large = { ...options, client: attachmentsFetch(messageWithAttachments(ATTACHMENT_CAP + 1)) };
  await assert.rejects(
    () => callTool("download_attachment", { message_id: "m1", part_id: "1" }, large),
    refused(422, /larger than 25 MB/),
  );
});

test("the Gmail adapter passes the run's workspace to download_attachment", async () => {
  const workspace = await agentWorkspace("gmail-adapter-");
  const ctx = { http: attachmentsFetch(), connection_id: "conn_gmail", settings: {} } as unknown as ConnectorContext;
  const args = { message_id: "m1", part_id: "1" };
  const saved = await gmailAdapter.call!("download_attachment", args, { access_token: TOKEN }, { ...ctx, workspace_dir: workspace });
  assert.equal(saved, "file_path=/home/a_1/invoice.pdf  application/pdf  bytes=3");
  await assert.rejects(
    () => gmailAdapter.call!("download_attachment", args, { access_token: TOKEN }, ctx),
    (error: unknown) => error instanceof ConnectorError && error.status === 422,
  );
});

test("download_attachment never writes through a link the agent planted", async () => {
  const workspace = await agentWorkspace("gmail-download-");
  const host = path.join(path.dirname(workspace), "config.json");
  await writeFile(host, "orchestrator config");
  await symlink(host, path.join(workspace, "invoice.pdf"));
  await assert.rejects(
    () =>
      callTool(
        "download_attachment",
        { message_id: "m1", part_id: "1" },
        { accessToken: TOKEN, client: attachmentsFetch(), workspaceDir: workspace },
      ),
    (error: unknown) => error instanceof GmailError && error.status === 422,
  );
  assert.equal(await readFile(host, "utf8"), "orchestrator config");
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
  const pool = new McpPool(new MemoryMcpDatabase(), 10 * 60 * 1000);
  pool.connectors = CONNECTORS.withAdapter("gmail", {
    async validate(creds) {
      const accessToken = creds.access_token;
      pinged += 1;
      assert.equal(accessToken, TOKEN);
      return "ada@example.com";
    },
  });
  const [ciphertext, nonce] = encryptPayload({ access_token: TOKEN }, KEY);
  const connection = connectionRow({ id: "conn_gmail", status: "connected", ciphertext, nonce });
  const server = serverRow("gmail", { id: "mcp_gmail", auth: "oauth", config: { url: "https://gmail.googleapis.com/gmail/v1" } });
  const first = await pool.syncTools(connection, server, { force: true });
  const second = await pool.syncTools(connection, server);
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
  const pool = new McpPool(new MemoryMcpDatabase());
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
    connectionRow({ id: "conn_gmail", status: "connected", ciphertext, nonce }),
    serverRow("gmail", { id: "mcp_gmail", auth: "oauth" }),
    { tool: "search_threads", arguments: { query: "from:ada" }, caller: OPERATOR_CALLER },
  );
  assert.equal(stored, "from:ada  n=0");
  assert.deepEqual(seen, { name: "search_threads", arguments: { query: "from:ada" }, token: TOKEN });
});

test("sync Gmail disconnects a login with no token to refresh", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const [ciphertext, nonce] = encryptPayload({}, KEY);
  const db = new MemoryMcpDatabase();
  await assert.rejects(
    () =>
      new McpPool(db).syncTools(
        connectionRow({ id: "conn_gmail", status: "connected", ciphertext, nonce }),
        serverRow("gmail", { id: "mcp_gmail", auth: "oauth" }),
        { force: true },
      ),
    (error: unknown) => error instanceof McpDisconnectedError,
  );
  assert.deepEqual(db.saved, ["conn_gmail:disconnected"]);
});
