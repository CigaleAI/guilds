import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { CONNECTORS } from "../../src/connectors/index.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import { decodeMasterKey } from "../../src/config/index.js";
import {
  CALL_TOOL_TIMEOUT_MS,
  ListedTool,
  McpDisconnectedError,
  McpError,
  McpPool,
  authHeaders,
  isReadOnlyRemote,
  mcpSchema,
  rpcPayload,
} from "../../src/mcp/index.js";
import { TOKEN_REFRESH_MS } from "../../src/github/tokens.js";
import { setInstanceKeys } from "../../src/instance/integrations.js";
import { HEX_MASTER_KEY, storeKeys } from "../helpers/env.js";

const KEY = decodeMasterKey(HEX_MASTER_KEY);

function connectionOf(token: string, extra: Record<string, unknown> = {}) {
  const [ciphertext, nonce] = encryptPayload({ token }, KEY);
  return { id: "conn_1", status: "connected", ciphertext, nonce, ...extra };
}

class MemoryDb {
  rows: Array<Record<string, unknown>> = [];
  bindings = new Map<string, Record<string, unknown>>();

  async replaceMcpTools(_connectionId: string, tools: ListedTool[], now: Date) {
    this.rows = tools.map((tool) => ({
      remote_name: tool.remote_name,
      namespaced_name: tool.namespaced_name,
      description: tool.description,
      input_schema: tool.input_schema,
      listed_at: now.toISOString(),
    }));
  }

  async listMcpTools() {
    return this.rows;
  }

  async insertBindingIfAbsent(
    bindingId: string,
    catalogKind: string,
    catalogId: string,
    scope: string,
    scopeId: string | null,
    enabled: boolean,
  ) {
    const key = `${catalogKind}:${catalogId}:${scopeId}`;
    const existing = this.bindings.get(key);
    if (existing) {
      return existing;
    }
    const row = {
      id: bindingId,
      catalog_kind: catalogKind,
      catalog_id: catalogId,
      scope,
      scope_id: scopeId,
      enabled,
    };
    this.bindings.set(key, row);
    return row;
  }
}

test("hosted MCP tool calls wait longer than adapter HTTP", () => {
  assert.equal(CALL_TOOL_TIMEOUT_MS, 90_000);
});

test("hosted MCP calls drop empty optional strings only", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const pool = new McpPool();
  pool.session = async () =>
    ({
      async callTool(_name: string, arguments_: Record<string, unknown>) {
        seen.push(arguments_);
        return "ok";
      },
    }) as never;
  const db = new MemoryDb();
  db.rows = [
    {
      remote_name: "generate_reply_options",
      namespaced_name: "cigale_generate_reply_options",
      description: "Draft replies",
      input_schema: {
        type: "object",
        properties: {
          tweetId: { type: "string" },
          agentId: { type: "string" },
          campaignId: { type: "string" },
          prompt: { type: "string" },
        },
        required: ["tweetId", "agentId"],
      },
    },
  ];
  const result = await pool.call(
    db as never,
    { id: "conn_1", status: "connected", ciphertext: Buffer.alloc(0), nonce: Buffer.alloc(0) },
    { slug: "cigale", auth: "token", config: { url: "https://api.cigale.ai/api/v1/public/mcp" } },
    "generate_reply_options",
    {
      tweetId: "",
      agentId: "11111111-1111-1111-1111-111111111111",
      campaignId: "",
      prompt: "Reply",
    },
  );
  assert.equal(result, "ok");
  assert.deepEqual(seen, [
    {
      tweetId: "",
      agentId: "11111111-1111-1111-1111-111111111111",
      prompt: "Reply",
    },
  ]);
});

test("offered Cigale schema marks optional strings for omit", () => {
  const schema = mcpSchema(
    new ListedTool("generate_reply_options", "cigale_generate_reply_options", "Draft replies", {
      type: "object",
      properties: {
        tweetId: { type: "string", minLength: 1 },
        agentId: { type: "string", format: "uuid" },
        campaignId: { type: "string", format: "uuid", description: "Campaign id (UUID)." },
        prompt: { type: "string", maxLength: 2000 },
      },
      required: ["tweetId", "agentId"],
      additionalProperties: false,
    }),
  );
  const parameters = (schema.function as { parameters: Record<string, unknown> }).parameters;
  const properties = parameters.properties as {
    campaignId: Record<string, unknown>;
    prompt: Record<string, unknown>;
    agentId: Record<string, unknown>;
  };
  assert.equal("format" in properties.campaignId, false);
  assert.equal("additionalProperties" in parameters, false);
  assert.match(String(properties.campaignId.description), /Omit this key when unused/);
  assert.match(String(properties.prompt.description), /Omit this key when unused/);
  assert.equal("description" in properties.agentId, false);
});

test("mcpSchema drops format uuid from optional properties", () => {
  const schema = mcpSchema(
    new ListedTool("generate_reply_options", "cigale_generate_reply_options", "Draft replies", {
      type: "object",
      properties: {
        tweetId: { type: "string" },
        agentId: { type: "string", format: "uuid" },
        campaignId: { type: "string", format: "uuid", description: "Optional campaign id" },
        seenAt: { type: "string", format: "date-time" },
        nested: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", format: "uuid" },
          },
        },
        ids: {
          type: "array",
          items: { type: "string", format: "uuid" },
        },
      },
      required: ["tweetId", "agentId"],
      additionalProperties: false,
    }),
  );
  const parameters = (schema.function as { parameters: Record<string, unknown> }).parameters;
  const properties = parameters.properties as {
    agentId: Record<string, unknown>;
    campaignId: Record<string, unknown>;
    seenAt: Record<string, unknown>;
    nested: { required: string[]; properties: { id: Record<string, unknown> } };
    ids: { items: Record<string, unknown> };
  };
  assert.equal(properties.agentId.format, "uuid");
  assert.equal("format" in properties.campaignId, false);
  assert.equal(properties.campaignId.description, "Optional campaign id");
  assert.equal("format" in properties.seenAt, false);
  assert.equal("format" in properties.nested.properties.id, false);
  assert.deepEqual(properties.nested.required, ["id"]);
  assert.equal("format" in properties.ids.items, false);
  assert.deepEqual(parameters.required, ["tweetId", "agentId"]);
});

test("mcpSchema drops format on nullable required properties", () => {
  const schema = mcpSchema(
    new ListedTool("generate_reply_options", "cigale_generate_reply_options", "Draft replies", {
      type: "object",
      properties: {
        tweetId: { type: "string" },
        campaignId: {
          anyOf: [{ type: "string", format: "uuid" }, { type: "null" }],
          description: "Optional campaign id",
        },
        window: {
          type: ["string", "null"],
          format: "date-time",
        },
      },
      required: ["tweetId", "campaignId", "window"],
    }),
  );
  const properties = (
    schema.function as {
      parameters: {
        properties: {
          campaignId: { anyOf: Array<Record<string, unknown>> };
          window: Record<string, unknown>;
        };
      };
    }
  ).parameters.properties;
  assert.equal("format" in properties.campaignId.anyOf[0]!, false);
  assert.equal("format" in properties.window, false);
});

test("isReadOnlyRemote classifies tools Studio may proxy", () => {
  assert.equal(isReadOnlyRemote("notion", "notion-search"), true);
  assert.equal(isReadOnlyRemote("notion", "notion-fetch"), true);
  assert.equal(isReadOnlyRemote("notion", "notion-get-users"), true);
  assert.equal(isReadOnlyRemote("notion", "notion-create-pages"), false);
  assert.equal(isReadOnlyRemote("notion", "notion-update-page"), false);
  assert.equal(isReadOnlyRemote("notion", "notion-move-pages"), false);
  assert.equal(isReadOnlyRemote("gmail", "search_messages"), true);
  assert.equal(isReadOnlyRemote("gmail", "send_message"), false);
  assert.equal(isReadOnlyRemote("drive", "search_files"), true);
  assert.equal(isReadOnlyRemote("drive", "read_file_content"), true);
  assert.equal(isReadOnlyRemote("drive", "create_file"), false);
  assert.equal(isReadOnlyRemote("drive", "copy_file"), false);
  assert.equal(isReadOnlyRemote("gmail", "createDraft"), false);
  assert.equal(isReadOnlyRemote("gmail", "trash_message"), false);
  assert.equal(isReadOnlyRemote("x", "post"), true);
  assert.equal(isReadOnlyRemote("twitterapiio", "replies"), true);
  assert.equal(isReadOnlyRemote("coingecko", "search"), true);
  assert.equal(isReadOnlyRemote("wallet", "get_balance"), true);
  assert.equal(isReadOnlyRemote("wallet", "send"), false);
  assert.equal(isReadOnlyRemote("wallet", "swap"), false);
  assert.equal(isReadOnlyRemote("wallet", "uniswap_swap"), false);
  assert.equal(isReadOnlyRemote("opensea", "search_collections"), true);
  assert.equal(isReadOnlyRemote("opensea", "manage_wallets"), false);
  assert.equal(isReadOnlyRemote("etherscan", "get_transaction"), true);
  assert.equal(isReadOnlyRemote("qonto", "list_bank_accounts"), true);
  assert.equal(isReadOnlyRemote("qonto", "list_missing_invoices"), true);
  assert.equal(isReadOnlyRemote("qonto", "get_transaction"), true);
  assert.equal(isReadOnlyRemote("qonto", "upload_invoice"), false);
  assert.equal(isReadOnlyRemote("github", "push_files"), false);
  assert.equal(isReadOnlyRemote("github", "merge_pull_request"), false);
  assert.equal(isReadOnlyRemote("github", "actions_run_trigger"), false);
  assert.equal(isReadOnlyRemote("github", "pull_request_read"), true);
});

test("rpc payload keeps jsonrpc result on 403", () => {
  const payload = rpcPayload({
    status: 403,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { tools: [{ name: "create_draft" }] },
    }),
  }) as { result: { tools: Array<{ name: string }> } };
  assert.equal(payload.result.tools[0]?.name, "create_draft");
});

test("rpc payload 403 without result is an error", () => {
  assert.throws(
    () => rpcPayload({ status: 403, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: { message: "forbidden" } }) }),
    (error: unknown) => error instanceof McpError && error.status === 403 && /mcp 403/.test(error.message),
  );
});

test("rpc payload 401 stays 401", () => {
  assert.throws(
    () => rpcPayload({ status: 401, body: "" }),
    (error: unknown) => error instanceof McpError && error.status === 401 && /mcp 401/.test(error.message),
  );
});

test("syncTools uses stored catalog within TTL", async () => {
  const session = { listed: 0, async listTools() {
    this.listed += 1;
    return [{ name: "search", description: "Search", inputSchema: {} }];
  } };
  const pool = new McpPool(10 * 60 * 1000);
  pool.session = async () => session as never;
  const db = new MemoryDb();
  const connection = { id: "conn_1", status: "connected", ciphertext: Buffer.alloc(0), nonce: Buffer.alloc(0) };
  const server = { id: "mcp_notion", slug: "notion", auth: "oauth" };
  const first = await pool.syncTools(db, connection, server);
  const second = await pool.syncTools(db, connection, server);
  assert.equal(session.listed, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(first, [new ListedTool("search", "notion_search", "Search", { type: "object" })]);
  await pool.syncTools(db, connection, server, { force: true });
  assert.equal(session.listed, 2);
});

test("syncTools treats listed_at as fresh across a new pool", async () => {
  const session = { listed: 0, async listTools() {
    this.listed += 1;
    return [{ name: "search", description: "Search", inputSchema: {} }];
  } };
  const db = new MemoryDb();
  const connection = { id: "conn_1", status: "connected", ciphertext: Buffer.alloc(0), nonce: Buffer.alloc(0) };
  const server = { id: "mcp_notion", slug: "notion", auth: "oauth" };
  const firstPool = new McpPool(10 * 60 * 1000);
  firstPool.session = async () => session as never;
  await firstPool.syncTools(db, connection, server);
  const secondPool = new McpPool(10 * 60 * 1000);
  secondPool.session = async () => session as never;
  await secondPool.syncTools(db, connection, server);
  assert.equal(session.listed, 1);
});

test("syncTools re-lists when listed_at is older than the TTL", async () => {
  const session = { listed: 0, async listTools() {
    this.listed += 1;
    return [{ name: "search", description: "Search", inputSchema: {} }];
  } };
  const db = new MemoryDb();
  db.rows = [
    {
      remote_name: "search",
      namespaced_name: "notion_search",
      description: "Search",
      input_schema: { type: "object" },
      listed_at: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
    },
  ];
  const pool = new McpPool(10 * 60 * 1000);
  pool.session = async () => session as never;
  await pool.syncTools(
    db,
    { id: "conn_1", status: "connected", ciphertext: Buffer.alloc(0), nonce: Buffer.alloc(0) },
    { id: "mcp_notion", slug: "notion", auth: "oauth" },
  );
  assert.equal(session.listed, 1);
});

test("auth headers send OpenSea API key", () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const connection = connectionOf("os-test");
  assert.deepEqual(authHeaders(connection, { slug: "opensea" }), { "X-API-KEY": "os-test" });
  assert.deepEqual(authHeaders(connection, { slug: "cigale" }), { Authorization: "Bearer os-test" });
  assert.deepEqual(authHeaders(connection, { slug: "etherscan" }), { Authorization: "Bearer os-test" });
});

test("a platform login sends the key its connector declares of its own; an organisation's login its own token", () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const manifest = {
    slug: "acme",
    display_name: "Acme",
    endpoint: { url: "https://mcp.acme.example.com/mcp" },
    auth: { kind: "token", header: { name: "X-Acme-Key", prefix: "" }, instance: { own: true } },
    description: "",
  };
  const server = { id: "mcp_acme", slug: "acme", auth: "token", manifest };
  const bearer = { ...server, manifest: { ...manifest, auth: { kind: "token", instance: { own: true } } } };
  const [ciphertext, nonce] = encryptPayload({}, KEY);
  const platform = { id: "conn_platform", status: "connected", owner_scope: "platform", owner_id: null, ciphertext, nonce };
  const org = connectionOf("org-token", { owner_scope: "org", owner_id: "org_1" });
  assert.deepEqual(authHeaders(platform, server), {}, "no key stored yet");
  assert.deepEqual(authHeaders(org, server), { "X-Acme-Key": "org-token" });
  setInstanceKeys(storeKeys({ "connector:acme": { token: "platform-key" } }));
  try {
    assert.deepEqual(authHeaders(platform, server), { "X-Acme-Key": "platform-key" });
    assert.deepEqual(authHeaders(platform, bearer), { Authorization: "Bearer platform-key" });
    assert.deepEqual(authHeaders(org, server), { "X-Acme-Key": "org-token" }, "an organisation's login keeps its own token");
    assert.deepEqual(authHeaders(platform, { ...server, manifest: { ...manifest, auth: { kind: "token" } } }), {}, "no platform key without auth.instance");
  } finally {
    setInstanceKeys({});
  }
  assert.deepEqual(authHeaders(platform, server), {});
});

test("an endpoint session sends a login's first credential field when it is not named token", () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const manifest = {
    slug: "acme",
    display_name: "Acme",
    endpoint: { url: "https://mcp.acme.example.com/mcp" },
    auth: {
      kind: "token",
      fields: [{ name: "api_key", label: "Acme key" }],
      header: { name: "X-Acme-Key", prefix: "" },
      instance: { own: true },
    },
    description: "",
  };
  const server = { id: "mcp_acme", slug: "acme", auth: "token", manifest };
  const [orgCiphertext, orgNonce] = encryptPayload({ api_key: "org-key" }, KEY);
  const org = { id: "conn_org", status: "connected", owner_scope: "org", owner_id: "org_1", ciphertext: orgCiphertext, nonce: orgNonce };
  const [ciphertext, nonce] = encryptPayload({}, KEY);
  const platform = { id: "conn_platform", status: "connected", owner_scope: "platform", owner_id: null, ciphertext, nonce };
  assert.deepEqual(authHeaders(org, server), { "X-Acme-Key": "org-key" });
  setInstanceKeys(storeKeys({ "connector:acme": { api_key: "platform-key" } }));
  try {
    assert.deepEqual(authHeaders(platform, server), { "X-Acme-Key": "platform-key" });
  } finally {
    setInstanceKeys({});
  }
});

test("sync OpenSea writes default-off and destructive tools Off, and reads On", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const pool = new McpPool(10 * 60 * 1000);
  pool.session = async () => ({
    async listTools() {
      return [
        { name: "search", description: "Search", inputSchema: {} },
        { name: "get_favorites", description: "Favorites", inputSchema: {} },
        { name: "get_instant_api_key", description: "Mint key", inputSchema: {} },
      ];
    },
  }) as never;
  const db = new MemoryDb();
  const server = { id: "mcp_opensea", slug: "opensea", auth: "token" };
  const first = await pool.syncTools(db, connectionOf("os-test", { owner_scope: "guild", owner_id: "guild_1" }), server, { force: true });
  const second = await pool.syncTools(db, connectionOf("os-test", { owner_scope: "guild", owner_id: "guild_1" }), server);
  assert.deepEqual(
    first.map((tool) => tool.namespaced_name),
    ["opensea_search", "opensea_get_favorites", "opensea_get_instant_api_key"],
  );
  assert.deepEqual(first, second);
  assert.deepEqual(first[0], new ListedTool("search", "opensea_search", "Search", { type: "object" }));
  assert.equal(db.bindings.get("mcp_tool:opensea_get_favorites:guild_1")?.enabled, false);
  assert.equal(db.bindings.get("mcp_tool:opensea_get_instant_api_key:guild_1")?.enabled, false);
  assert.equal(db.bindings.has("mcp_tool:opensea_search:guild_1"), false);
});

test("sync OpenSea rejects an unauthenticated catalog", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const pool = new McpPool();
  pool.session = async () => ({
    async listTools() {
      return [{ name: "get_instant_api_key", description: "Mint key", inputSchema: {} }];
    },
  }) as never;
  await assert.rejects(
    () => pool.syncTools(new MemoryDb(), connectionOf("bad"), { id: "mcp_opensea", slug: "opensea", auth: "token" }, { force: true }),
    (error: unknown) => error instanceof McpError && error.status === 401 && /api key was rejected/.test(error.message),
  );
});

const GITHUB_APP_KEYS = {
  app_id: "4242",
  slug: "guilds-test",
  private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  client_id: "Iv1.client",
  client_secret: "client-secret",
};
const GITHUB_SERVER = { id: "mcp_github", slug: "github", auth: "oauth", config: { url: "https://api.githubcopilot.com/mcp/" } };

function githubLogin(repositories: unknown[]): Record<string, unknown> {
  const [ciphertext, nonce] = encryptPayload({ installation_id: 77, account: "acme" }, KEY);
  return {
    id: "conn_gh",
    status: "connected",
    owner_scope: "guild",
    owner_id: "guild_1",
    account_hint: "acme",
    ciphertext,
    nonce,
    settings: { repositories },
  };
}

const PICKED = [{ name: "shop", url: "https://github.com/acme/shop", github_id: 101 }];

type GithubFakes = {
  /** The body of each token GitHub minted. */
  minted: Array<Record<string, unknown>>;
  /** The Authorization header of each tool call the endpoint received. */
  called: string[];
  /** The headers of every request the endpoint received. */
  sent: Array<Record<string, string>>;
};

/**
 * A pool whose GitHub API mints `ghs_<n>` tokens expiring at `expiry(n)`, and whose endpoint
 * lists `tools` and answers every tool call "ok", or 401 for a token `refuse` names.
 */
function githubPool(options: {
  expiry: (n: number) => number;
  refuse?: (token: string) => boolean;
  mint?: () => Response;
  tools?: Array<Record<string, unknown>>;
}): { pool: McpPool; fakes: GithubFakes } {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  setInstanceKeys(storeKeys({ "github-app": GITHUB_APP_KEYS }));
  const fakes: GithubFakes = { minted: [], called: [], sent: [] };
  const pool = new McpPool();
  pool.connectors = CONNECTORS;
  pool.fetchFn = async (url, init = {}) => {
    assert.equal(url, "https://api.github.com/app/installations/77/access_tokens");
    if (options.mint) {
      return options.mint();
    }
    fakes.minted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const n = fakes.minted.length;
    return new Response(
      JSON.stringify({
        token: `ghs_${n}`,
        expires_at: new Date(options.expiry(n)).toISOString(),
        repositories: [{ id: 101, full_name: "acme/shop" }],
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  };
  pool.endpointFetch = async (_url, init = {}) => {
    fakes.sent.push(init.headers as Record<string, string>);
    const authorization = String((init.headers as Record<string, string>).Authorization);
    const body = JSON.parse(String(init.body)) as { id?: number; method: string };
    if (options.refuse?.(authorization.replace("Bearer ", ""))) {
      return new Response("", { status: 401 });
    }
    if (body.method === "tools/call") {
      fakes.called.push(authorization);
    }
    const results: Record<string, unknown> = {
      "tools/call": { content: [{ type: "text", text: "ok" }] },
      "tools/list": { tools: options.tools ?? [] },
    };
    const result = results[body.method] ?? {};
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { pool, fakes };
}

test("a GitHub App login's session sends a token for its picked repositories, minted again near expiry", async () => {
  const { pool, fakes } = githubPool({
    expiry: (n) => Date.now() + (n === 1 ? TOKEN_REFRESH_MS - 1000 : 3_600_000),
  });
  try {
    const db = new MemoryDb();
    for (let index = 0; index < 3; index += 1) {
      assert.equal(await pool.call(db as never, githubLogin(PICKED), GITHUB_SERVER, "list_issues", {}), "ok");
    }
    assert.deepEqual(fakes.minted, [{ repository_ids: [101] }, { repository_ids: [101] }], "every permission the installation grants");
    assert.deepEqual(fakes.called, ["Bearer ghs_1", "Bearer ghs_2", "Bearer ghs_2"]);
  } finally {
    setInstanceKeys({});
  }
});

test("a GitHub App login whose token the endpoint refuses gets a new one and stays connected", async () => {
  const { pool, fakes } = githubPool({ expiry: () => Date.now() + 3_600_000, refuse: (token) => token === "ghs_1" });
  const saved: string[] = [];
  const db = Object.assign(new MemoryDb(), {
    saveMcpConnection: async (_id: string, options: { status: string }) => {
      saved.push(options.status);
      return null;
    },
  });
  try {
    assert.equal(await pool.call(db as never, githubLogin(PICKED), GITHUB_SERVER, "list_issues", {}), "ok");
    assert.equal(fakes.minted.length, 2);
    assert.deepEqual(fakes.called, ["Bearer ghs_2"]);
    assert.deepEqual(saved, []);
  } finally {
    setInstanceKeys({});
  }
});

test("GitHub refusing a GitHub App login's installation disconnects the login", async () => {
  const { pool } = githubPool({
    expiry: () => Date.now() + 3_600_000,
    mint: () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
  });
  const saved: string[] = [];
  const db = Object.assign(new MemoryDb(), {
    saveMcpConnection: async (id: string, options: { status: string }) => {
      saved.push(`${id}:${options.status}`);
      return null;
    },
  });
  try {
    await assert.rejects(
      pool.call(db as never, githubLogin(PICKED), GITHUB_SERVER, "list_issues", {}),
      McpDisconnectedError,
    );
    assert.deepEqual(saved, ["conn_gh:disconnected"]);
  } finally {
    setInstanceKeys({});
  }
});

test("a GitHub App login lists the connector's toolsets, without the tools its manifest excludes, writes Off", async () => {
  const listed = (name: string, readOnly: boolean) => ({
    name,
    description: name,
    inputSchema: { type: "object" },
    annotations: readOnly ? { readOnlyHint: true } : {},
  });
  const { pool, fakes } = githubPool({
    expiry: () => Date.now() + 3_600_000,
    tools: [
      listed("list_issues", true),
      listed("issue_write", false),
      listed("merge_pull_request", false),
      listed("create_repository", false),
      listed("fork_repository", false),
    ],
  });
  const db = new MemoryDb();
  try {
    const tools = await pool.syncTools(db as never, githubLogin(PICKED), GITHUB_SERVER, { force: true });
    assert.deepEqual(
      tools.map((tool) => tool.namespaced_name),
      ["github_list_issues", "github_issue_write", "github_merge_pull_request"],
    );
    assert.equal(db.bindings.has("mcp_tool:github_list_issues:guild_1"), false);
    assert.equal(db.bindings.get("mcp_tool:github_issue_write:guild_1")?.enabled, false);
    assert.equal(db.bindings.get("mcp_tool:github_merge_pull_request:guild_1")?.enabled, false);
    assert.ok(fakes.sent.length > 0);
    for (const headers of fakes.sent) {
      assert.equal(headers["X-MCP-Toolsets"], "repos,issues,pull_requests,actions");
      assert.equal(headers.Authorization, "Bearer ghs_1");
    }
  } finally {
    setInstanceKeys({});
  }
});

test("a GitHub App login with no repositories picked gets no token", async () => {
  const { pool, fakes } = githubPool({ expiry: () => Date.now() + 3_600_000 });
  try {
    await assert.rejects(
      pool.call(new MemoryDb() as never, githubLogin([]), GITHUB_SERVER, "list_issues", {}),
      (error: unknown) => error instanceof McpError && /GitHub login for acme has no repositories picked/.test(error.message),
    );
    assert.deepEqual(fakes.minted, []);
  } finally {
    setInstanceKeys({});
  }
});
