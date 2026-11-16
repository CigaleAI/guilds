import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildHarnessMcpApp } from "../../src/app.js";
import { HarnessMcpServer, type HarnessMcpDatabase } from "../../src/generation/harness-mcp.js";
import type { SubscriptionGeneration } from "../../src/generation/harness-loop.js";
import type { GenerationTools, ToolCalls } from "../../src/generation/tool-calls.js";
import { McpSession } from "../../src/mcp/session.js";
import { schemasFor } from "../../src/toolbox/index.js";
import { AGENT_CONFIG, agentRow } from "../helpers/generation.js";

const agent = agentRow({ id: "a_1", config: { ...AGENT_CONFIG, model: null, harness: "claude-code" } });
const schemas = schemasFor(["note_find"]);
const server = new HarnessMcpServer(
  {
    db: { getAgent: async () => agent, listBindingsCovering: async () => [], listMessages: async () => [] } as unknown as HarnessMcpDatabase,
    toolCalls: {} as ToolCalls,
  },
  "http://127.0.0.1:0",
);
const gen = { runId: "r_1", generation: 1, log: { run_id: "r_1" }, run: { kind: "direct" }, agent, snapshot: { tools: schemas } } as unknown as SubscriptionGeneration;
const tools = { run: { offered_tools: new Set(["note_find"]), dynamic_tools: {} }, schemas, connections: new Map(), maxToolCalls: 5 } as unknown as GenerationTools;
let app: FastifyInstance;
let base = "";

before(async () => {
  app = await buildHarnessMcpApp(server);
  await app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(async () => {
  await app.close();
});

const INITIALIZE = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });

function post(path: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
}

test("the orchestrator's own MCP client initializes, lists the run's tools, and speaks the session through the listener", async () => {
  const { access } = server.open(gen, tools);
  const session = new McpSession(`${base}/mcp/a_1`, { Authorization: `Bearer ${access.token}` }, fetch);
  const info = await session.initialize();
  assert.equal(info.name, "guilds");
  const listed = await session.listTools();
  assert.deepEqual(listed.map((tool) => tool.name), ["note_find"]);
});

test("a request that holds no grant is refused with 401 and says nothing more", async () => {
  const { access } = server.open(gen, tools);
  for (const [path, headers] of [
    ["/mcp/a_1", {}],
    ["/mcp/a_1", { authorization: "Bearer wrong" }],
    ["/mcp/a_2", { authorization: `Bearer ${access.token}` }],
  ] as const) {
    const response = await post(path, INITIALIZE, headers);
    assert.equal(response.status, 401, path);
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  }
});

test("a notification is accepted with 202 and no body", async () => {
  const { access } = server.open(gen, tools);
  const response = await post("/mcp/a_1", JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), {
    authorization: `Bearer ${access.token}`,
  });
  assert.equal(response.status, 202);
  assert.equal(await response.text(), "");
});

test("the stream and the session's end are not served, and nothing but the MCP path and the liveness check is", async () => {
  const stream = await fetch(`${base}/mcp/a_1`, { headers: { accept: "text/event-stream" } });
  assert.equal(stream.status, 405);
  assert.equal(stream.headers.get("allow"), "POST");
  assert.equal((await fetch(`${base}/mcp/a_1`, { method: "DELETE" })).status, 405);
  for (const path of ["/api/guilds", "/", "/avatars/clay.svg", "/mcp", "/.well-known/oauth-protected-resource"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: "not found" });
  }
  const health = await fetch(`${base}/health`);
  assert.deepEqual(await health.json(), { status: "ok" });
});

test("a message that is not JSON-RPC, and one too large, are refused by status alone", async () => {
  const bad = await post("/mcp/a_1", JSON.stringify({ method: "initialize" }));
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "bad request" });
  const large = await post("/mcp/a_1", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { pad: "x".repeat(1024 * 1024) } }));
  assert.equal(large.status, 413);
  assert.deepEqual(await large.json(), { error: "request too large" });
});
