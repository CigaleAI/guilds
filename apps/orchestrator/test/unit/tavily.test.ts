import assert from "node:assert/strict";
import { test } from "node:test";
import { agentRuntimeThrough } from "../../src/access/runtime.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import { decodeMasterKey } from "../../src/config/index.js";
import { NATIVE_TOOLS } from "../../src/seed/catalog.js";
import { CONNECTORS } from "../../src/connectors/index.js";
import { instanceCredentials, instanceKey, instanceRedactions } from "../../src/connectors/instance.js";
import { TavilyError, formatSearch, search } from "../../src/connectors/tavily/client.js";
import { McpPool, OPERATOR_CALLER } from "../../src/mcp/pool.js";
import { UNLIMITED, type OrgPolicy } from "../../src/policy/index.js";
import { REGISTRY } from "../../src/toolbox/index.js";
import { identityOutput, processOutput } from "../../src/toolbox/output.js";
import { setInstanceKeys } from "../../src/instance/integrations.js";
import { HEX_MASTER_KEY, storeKeys } from "../helpers/env.js";
import { loadJsonFixture } from "../helpers/fixtures.js";
import { mockFetch } from "../helpers/http.js";
import { serverRow, connectionRow } from "../helpers/servers.js";
import type { McpConnectionRow } from "../../src/db/mcp.js";
import { MemoryMcpDatabase } from "../helpers/mcp-database.js";

const fixture = loadJsonFixture<{ results: string; empty: string }>("adapters/tavily.json");

const KEY = decodeMasterKey(HEX_MASTER_KEY);
const TAVILY = CONNECTORS.bySlug("tavily")!;
const SERVER = serverRow("tavily", { id: "mcp_tavily", auth: "token" });

/** Holds the web search key in the process's instance keys for one block, then empties them. */
async function withInstanceKey<T>(value: string, work: () => Promise<T>): Promise<T> {
  setInstanceKeys(storeKeys({ "web-search": { api_key: value } }));
  try {
    return await work();
  } finally {
    setInstanceKeys({});
  }
}

function webSearch(apiKey: string) {
  return { keys: storeKeys({ "web-search": { api_key: apiKey } }) };
}

function login(
  scope: "platform" | "org",
  payload: Record<string, unknown>,
  status: McpConnectionRow["status"] = "connected",
): McpConnectionRow {
  const [ciphertext, nonce] = encryptPayload(payload, KEY);
  return connectionRow({
    id: `conn_${scope}`,
    mcp_server_id: SERVER.id,
    owner_scope: scope,
    owner_id: scope === "platform" ? null : "org_1",
    status,
    ciphertext,
    nonce,
  });
}

function searchPool(seen: string[], database = new MemoryMcpDatabase()): McpPool {
  const pool = new McpPool(database);
  pool.fetchFn = mockFetch((_url, init) => {
    seen.push(String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ""));
    return { status: 200, json: { results: [{ title: "Messi", url: "https://example.com/messi", content: "Footballer" }] } };
  });
  return pool;
}

test("formatSearch joins title, url, and content", () => {
  assert.equal(
    formatSearch({
      results: [
        { title: "Messi", url: "https://example.com/messi", content: "Footballer" },
        { title: "  ", url: "https://example.com/empty", content: null },
      ],
    }),
    fixture.results,
  );
});

test("formatSearch empty is no results", () => {
  assert.equal(formatSearch({}), fixture.empty);
  assert.equal(formatSearch({ results: [] }), fixture.empty);
  assert.equal(formatSearch({ results: [{ title: 1 }] }), fixture.empty);
});

test("search requires a query", async () => {
  await assert.rejects(() => search("   ", { apiKey: "tvly-test", client: mockFetch(() => ({ status: 200 })) }), /query is required/);
});

test("search posts an advanced query with the key", async () => {
  let url = "";
  let authorization = "";
  let body = "";
  const stored = await search("who is Leo Messi?", {
    apiKey: "tvly-test",
    client: mockFetch((requestUrl, init) => {
      url = requestUrl;
      authorization = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
      body = String(init?.body ?? "");
      return {
        status: 200,
        json: { results: [{ title: "Messi", url: "https://example.com/messi", content: "Footballer" }] },
      };
    }),
  });
  assert.equal(url, "https://api.tavily.com/search");
  assert.equal(authorization, "Bearer tvly-test");
  assert.deepEqual(JSON.parse(body), { query: "who is Leo Messi?", search_depth: "advanced" });
  assert.equal(stored, "Messi\nhttps://example.com/messi\nFootballer");
});

test("search refuses a body that is not JSON or does not match its schema", async () => {
  const answering = (result: { json?: unknown; text?: string }) => ({
    apiKey: "tvly-test",
    client: mockFetch(() => ({ status: 200, ...result })),
  });
  await assert.rejects(
    () => search("messi", answering({ json: { results: "none" } })),
    (error: unknown) =>
      error instanceof TavilyError &&
      /^Tavily returned an unexpected response at \/results: /.test(error.message),
  );
  await assert.rejects(
    () => search("messi", answering({ text: "not json" })),
    (error: unknown) =>
      error instanceof TavilyError && error.message === "Tavily returned a non-JSON body",
  );
});

test("search HTTP error", async () => {
  await assert.rejects(
    () =>
      search("who is Leo Messi?", {
        apiKey: "tvly-test",
        client: mockFetch(() => ({ status: 401, json: { detail: { error: "Unauthorized" } } })),
      }),
    (error: unknown) => error instanceof TavilyError && error.message === "Unauthorized" && error.status === 401,
  );
});

test("web search is the Tavily connector's search tool, not a native tool", () => {
  assert.ok(!(NATIVE_TOOLS as readonly string[]).includes("tavily_search"));
  assert.equal(REGISTRY.tavily_search, undefined);
  assert.deepEqual(TAVILY.manifest.auth.instance, { integration: "web-search", field: "api_key" });
  assert.deepEqual(
    TAVILY.manifest.tools?.map((tool) => tool.name),
    ["search"],
  );
});

test("the instance key serves the platform login while the integration is on", () => {
  assert.equal(instanceKey(TAVILY.manifest, { keys: {} }), null);
  assert.equal(instanceKey(TAVILY.manifest, webSearch("  ")), null);
  assert.equal(instanceKey(TAVILY.manifest, webSearch(" tvly-instance ")), "tvly-instance");
  assert.deepEqual(instanceCredentials(TAVILY.manifest, webSearch("tvly-instance")), { token: "tvly-instance" });
  assert.deepEqual(instanceCredentials(TAVILY.manifest, { keys: {} }), {});
  assert.equal(instanceKey(CONNECTORS.bySlug("gmail")!.manifest, webSearch("tvly-instance")), null);
  assert.equal(instanceKey(TAVILY.manifest, { env: { TAVILY_API_KEY: "tvly-env" }, keys: {} }), null, "the environment no longer serves the key");
});

test("the instance key is redacted from tool output under the connector's field", () => {
  assert.deepEqual(instanceRedactions({ keys: {} }), {});
  const redactions = instanceRedactions(webSearch("tvly-platform-key"));
  assert.deepEqual(redactions, { platform_tavily_api_key: "tvly-platform-key" });
  const [content] = processOutput("ERROR: key tvly-platform-key rejected", identityOutput, redactions, 4096);
  assert.equal(content, "ERROR: key [REDACTED:platform_tavily_api_key] rejected");
});

test("a platform login calls with the instance key; an organisation's login with its own", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const seen: string[] = [];
  const pool = searchPool(seen);
  await withInstanceKey("tvly-instance", async () => {
    const result = await pool.call(login("platform", {}), SERVER, { tool: "search", arguments: { query: "messi" }, caller: OPERATOR_CALLER });
    assert.equal(result, "Messi\nhttps://example.com/messi\nFootballer");
    await pool.call(login("org", { token: "tvly-own" }), SERVER, { tool: "search", arguments: { query: "messi" }, caller: OPERATOR_CALLER });
  });
  assert.deepEqual(seen, ["Bearer tvly-instance", "Bearer tvly-own"]);
});

test("a plan's monthly cap refuses platform-login calls past it and leaves an organisation's own key alone", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const seen: string[] = [];
  const db = new MemoryMcpDatabase();
  const pool = searchPool(seen, db);
  const policy: OrgPolicy = {
    async standing() {
      return { limits: { ...UNLIMITED, source: "plan", monthlyConnectorCalls: { tavily: 2 } }, blocked: null };
    },
  };
  pool.policy = policy;
  await withInstanceKey("tvly-instance", async () => {
    const platform = login("platform", {});
    const results = [];
    for (let index = 0; index < 3; index += 1) {
      results.push(await pool.call(platform, SERVER, { tool: "search", arguments: { query: "q" }, caller: { orgId: "org_1", workspaceDir: null } }));
    }
    assert.equal(results[2], "ERROR: plan limit reached: tavily calls this month");
    assert.equal(seen.length, 2);
    assert.equal(
      await pool.call(platform, SERVER, { tool: "search", arguments: { query: "q" }, caller: { orgId: "org_2", workspaceDir: null } }),
      "Messi\nhttps://example.com/messi\nFootballer",
    );
    await pool.call(login("org", { token: "tvly-own" }), SERVER, { tool: "search", arguments: { query: "q" }, caller: { orgId: "org_1", workspaceDir: null } });
  });
  assert.equal(seen.length, 4);
  assert.deepEqual([...db.calls.values()], [2, 1]);
});

test("a disconnected platform login is left out of a run, not an error", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const platform = login("platform", {}, "disconnected");
  const db = {
    async listBindingsCovering() {
      return [{ catalog_kind: "mcp", catalog_id: SERVER.id, scope: "platform", scope_id: null, enabled: true, connection_id: platform.id }];
    },
    async listAgentSecrets() {
      return [];
    },
    async listServers() {
      return [SERVER];
    },
    async listMcpConnections() {
      return [platform];
    },
  };
  const runtime = await agentRuntimeThrough(db as never, { id: "a_1", guild_id: "guild_1", org_id: "org_1" });
  assert.deepEqual(runtime.mcp, []);
});
