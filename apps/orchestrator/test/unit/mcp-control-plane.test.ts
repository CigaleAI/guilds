import assert from "node:assert/strict";
import type { McpConnectionRow } from "../../src/db/mcp.js";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { test } from "node:test";
import { agentRuntime, snapshotEnvValues } from "../../src/access/runtime.js";
import { loadAccessView } from "../../src/access/view.js";
import { encryptPayload, environmentFingerprint } from "../../src/credentials/crypto.js";
import { decodeMasterKey } from "../../src/config/index.js";
import { McpError } from "../../src/mcp/errors.js";
import { CALL_TOOL_TIMEOUT_MS, McpSession, publicOnly } from "../../src/mcp/session.js";
import { McpPool, OPERATOR_CALLER } from "../../src/mcp/pool.js";
import { resolveConnectionTool } from "../../src/mcp/service.js";
import { proxyFetch } from "../../src/net/http.js";
import { CONNECTORS } from "../../src/connectors/index.js";
import { HEX_MASTER_KEY } from "../helpers/env.js";
import { serverRow, connectionRow } from "../helpers/servers.js";
import type { LoadedConnector } from "../../src/connectors/load.js";
import { MemoryMcpDatabase, storedTool } from "../helpers/mcp-database.js";

const GMAIL_TOOLS = CONNECTORS.bySlug("gmail")!.manifest.tools!;

const KEY = decodeMasterKey(HEX_MASTER_KEY);

type FixtureMode = "ok" | "error" | "malformed";

type Fixture = {
  url: string;
  listed: number;
  called: number;
  missingSession: number;
  mode: FixtureMode;
  close(): Promise<void>;
};

/** The pool's database, and the reads an agent's access and its access view make, on one memory. */
class MemoryDb extends MemoryMcpDatabase {
  secrets: Array<Record<string, unknown>> = [];
  ensureCalls = 0;

  async connectionTools(connection: McpConnectionRow, server: LoadedConnector) {
    return (await this.listMcpTools(connection.id)).map((row) => resolveConnectionTool(server, row));
  }

  async listBindingsCovering() {
    const mcp = this.connections.flatMap((connection) => [
      {
        catalog_kind: "mcp",
        catalog_id: connection.mcp_server_id,
        scope: connection.owner_scope,
        scope_id: connection.owner_id,
        enabled: true,
        connection_id: connection.id,
      },
    ]);
    return [...mcp, ...this.bindings.values()];
  }

  async listAgentSecrets() {
    return this.secrets;
  }

  async getSecret(secretId: string) {
    return this.secrets.find((row) => row.id === secretId) ?? null;
  }

  async listMcpServers() {
    return this.servers;
  }

  async listMcpConnections() {
    return this.connections;
  }

  async ensure() {
    this.ensureCalls += 1;
    throw new Error("sandbox.ensure must not run during catalog sync");
  }
}

function connectionOf(token: string, extra: Partial<McpConnectionRow> = {}): McpConnectionRow {
  const [ciphertext, nonce] = encryptPayload({ token, access_token: token }, KEY);
  return connectionRow({ id: "conn_1", mcp_server_id: "mcp_fixture", ciphertext, nonce, ...extra });
}

async function startFixture(): Promise<Fixture> {
  const state: Fixture = {
    url: "",
    listed: 0,
    called: 0,
    missingSession: 0,
    mode: "ok",
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
  let sessionId: string | null = null;
  const server: Server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      let body: { id?: unknown; method?: string } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as typeof body;
      } catch {
        response.statusCode = 400;
        response.end("not json");
        return;
      }
      const sid = String(request.headers["mcp-session-id"] ?? "");
      response.setHeader("content-type", "application/json");
      if (body.method === "initialize") {
        sessionId = "sess_fixture";
        response.setHeader("mcp-session-id", sessionId);
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              serverInfo: { name: "fixture", version: "1" },
            },
          }),
        );
        return;
      }
      if (body.method === "notifications/initialized") {
        response.end("{}");
        return;
      }
      if (!sessionId || sid !== sessionId) {
        state.missingSession += 1;
        response.statusCode = 400;
        response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { message: "missing session" } }));
        return;
      }
      if (body.method === "tools/list") {
        state.listed += 1;
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }] },
          }),
        );
        return;
      }
      if (body.method === "tools/call") {
        state.called += 1;
        if (state.mode === "error") {
          response.statusCode = 502;
          response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { message: "upstream failed" } }));
          return;
        }
        if (state.mode === "malformed") {
          response.end("not-json");
          return;
        }
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: "pong" }] },
          }),
        );
        return;
      }
      response.statusCode = 400;
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  state.url = `http://127.0.0.1:${port}/mcp`;
  return state;
}

test("local MCP fixture requires Mcp-Session-Id after initialize", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const fixture = await startFixture();
  try {
    const session = new McpSession(fixture.url, {});
    const tools = await session.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ["ping"]);
    assert.equal(fixture.listed, 1);
    assert.equal(fixture.missingSession, 0);
    assert.equal(await session.callTool("ping", {}), "pong");
    assert.equal(fixture.called, 1);
  } finally {
    await fixture.close();
  }
});

/** A pool that reaches the loopback fixture: the default pool refuses private addresses. */
function localPool(database = new MemoryMcpDatabase()): McpPool {
  const pool = new McpPool(database);
  pool.endpointFetch = proxyFetch("", CALL_TOOL_TIMEOUT_MS);
  return pool;
}

test("a session refuses an endpoint that resolves to a private address", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const fixture = await startFixture();
  try {
    const server = serverRow("fixture", { id: "mcp_fixture", auth: "token", config: { url: fixture.url } });
    await assert.rejects(
      () => new McpPool(new MemoryMcpDatabase()).call(connectionOf("mcp-test"), server, { tool: "ping", arguments: {}, caller: OPERATOR_CALLER }),
      (error: unknown) => error instanceof McpError && error.status === 403 && /private or local/.test(error.message),
    );
    assert.equal(fixture.called, 0);
    const resolvedInward = publicOnly(async () => new Response("{}"), async () => [{ address: "10.1.2.3" }]);
    await assert.rejects(() => resolvedInward("https://mcp.example.com/mcp"), /resolves to a private or local address/);
    const resolvedOut = publicOnly(async () => new Response("ok"), async () => [{ address: "93.184.216.34" }]);
    assert.equal(await (await resolvedOut("https://mcp.example.com/mcp")).text(), "ok");
  } finally {
    await fixture.close();
  }
});

test("catalog refresh does not call sandbox ensure", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const fixture = await startFixture();
  try {
    const db = new MemoryDb();
    const pool = localPool(db);
    const connection = connectionOf("mcp-test");
    const server = serverRow("fixture", { id: "mcp_fixture", display_name: "Fixture", auth: "token", config: { url: fixture.url } });
    db.servers = [server];
    db.connections = [connection];
    const runtime = await agentRuntime(db as never, { id: "a_1", guild_id: "guild_1", org_id: "org_1" }, { mcpPool: pool });
    assert.equal(db.ensureCalls, 0);
    assert.equal(fixture.listed, 1);
    assert.deepEqual(
      (runtime.mcp[0] as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name),
      ["fixture_ping"],
    );
    await agentRuntime(db as never, { id: "a_1", guild_id: "guild_1", org_id: "org_1" }, { mcpPool: pool });
    assert.equal(fixture.listed, 1);
    assert.equal(db.ensureCalls, 0);
  } finally {
    await fixture.close();
  }
});

test("token rotation does not change the sandbox environment fingerprint", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const db = new MemoryDb();
  db.connections = [connectionOf("token-one")];
  const first = environmentFingerprint(await snapshotEnvValues(db as never, []));
  db.connections = [connectionOf("token-two")];
  const second = environmentFingerprint(await snapshotEnvValues(db as never, []));
  assert.equal(first, second);
  assert.equal(first, environmentFingerprint({}));
});

test("provider error and malformed MCP result surface as McpError", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const fixture = await startFixture();
  const pool = localPool();
  const connection = connectionOf("mcp-test");
  const server = serverRow("fixture", { id: "mcp_fixture", auth: "token", config: { url: fixture.url } });
  try {
    fixture.mode = "error";
    await assert.rejects(
      () => pool.call(connection, server, { tool: "ping", arguments: {}, caller: OPERATOR_CALLER }),
      (error: unknown) => error instanceof McpError && error.status === 502,
    );
    fixture.mode = "malformed";
    await assert.rejects(() => pool.call(connection, server, { tool: "ping", arguments: {}, caller: OPERATOR_CALLER }));
  } finally {
    await fixture.close();
  }
});

test("gmail send stays Off and the sandbox env has no Gmail token", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const db = new MemoryDb();
  const pool = new McpPool(db);
  pool.connectors = CONNECTORS.withAdapter("gmail", { validate: async () => "ada@example.com" });
  const token = "ya29.gmail-secret";
  const connection = connectionOf(token, { id: "conn_gmail", mcp_server_id: "mcp_gmail" });
  db.servers = [serverRow("gmail", { display_name: "Gmail" })];
  db.connections = [connection];
  await pool.syncTools(connection, db.servers[0]!, { force: true });
  assert.equal(db.bindings.get("mcp_tool:gmail_send_message:org_1")?.enabled, false);
  const runtime = await agentRuntime(db as never, { id: "a_1", guild_id: "guild_1", org_id: "org_1" }, { mcpPool: pool });
  const offered = ((runtime.mcp[0] as { tools: Array<{ name: string }> } | undefined)?.tools ?? []).map(
    (tool) => tool.name,
  );
  assert.deepEqual(
    offered,
    GMAIL_TOOLS.filter((tool) => tool.name !== "send_message").map((tool) => `gmail_${tool.name}`),
  );
  const env = await snapshotEnvValues(db as never, runtime.secrets);
  assert.equal(Object.keys(env).length, 0);
  assert.ok(!JSON.stringify(env).includes(token));
});

test("a GitHub login's listed tools are offered to its agents like any connector's", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const db = new MemoryDb();
  db.servers = [serverRow("github", { id: "mcp_github", display_name: "GitHub", auth: "oauth" })];
  db.connections = [connectionOf("unused", { id: "conn_github", mcp_server_id: "mcp_github" })];
  db.tools = [
    storedTool(
      "conn_github",
      { remote_name: "list_issues", namespaced_name: "github_list_issues", description: "List issues", input_schema: { type: "object" } },
      new Date().toISOString(),
    ),
  ];
  const runtime = await agentRuntime(db as never, { id: "a_1", guild_id: "guild_1", org_id: "org_1" });
  assert.deepEqual(
    runtime.mcp.map((entry) => [entry.slug, (entry.tools as Array<{ name: string }>).map((tool) => tool.name)]),
    [["github", ["github_list_issues"]]],
  );
});

test("a run that lists a login's tools for the first time is not offered the ones that start Off", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const db = new MemoryDb();
  const pool = new McpPool(db);
  pool.session = async () =>
    ({
      async listTools() {
        return [
          { name: "ping", description: "Ping", inputSchema: { type: "object" } },
          { name: "send_ping", description: "Send a ping", inputSchema: { type: "object" } },
        ];
      },
    }) as never;
  db.servers = [serverRow("fixture", { id: "mcp_fixture", display_name: "Fixture", auth: "token", config: { url: "https://mcp.example.com/mcp" } })];
  db.connections = [connectionOf("mcp-test")];
  const runtime = await agentRuntime(db as never, { id: "a_1", guild_id: "guild_1", org_id: "org_1" }, { mcpPool: pool });
  assert.equal(db.bindings.get("mcp_tool:fixture_send_ping:org_1")?.enabled, false);
  assert.deepEqual(
    runtime.mcp.map((entry) => (entry.tools as Array<{ name: string }>).map((tool) => tool.name)),
    [["fixture_ping"]],
  );
});

test("the access view that lists a login's tools for the first time shows the ones that start Off as Off", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const db = new MemoryDb();
  const pool = new McpPool(db);
  pool.session = async () =>
    ({
      async listTools() {
        return [
          { name: "ping", description: "Ping", inputSchema: { type: "object" } },
          { name: "send_ping", description: "Send a ping", inputSchema: { type: "object" } },
        ];
      },
    }) as never;
  db.servers = [serverRow("fixture", { id: "mcp_fixture", display_name: "Fixture", auth: "token", config: { url: "https://mcp.example.com/mcp" } })];
  db.connections = [connectionOf("mcp-test")];
  const view = await loadAccessView(db as never, { orgId: "org_1", guildId: "guild_1", agentId: "a_1", viewScope: "agent", mcp: pool });
  const fixture = (view.mcp as Array<{ slug: string; tools: Array<{ name: string; enabled: boolean }> }>).find(
    (server) => server.slug === "fixture",
  );
  assert.deepEqual(
    fixture?.tools.map((tool) => [tool.name, tool.enabled]),
    [["fixture_ping", true], ["fixture_send_ping", false]],
  );
});
