import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMasterKey } from "../../src/config/index.js";
import { decryptPayload, encryptPayload } from "../../src/credentials/crypto.js";
import { connect, ConnectError, type ConnectInput } from "../../src/connectors/connect.js";
import type { ConnectorRow } from "../../src/db/connectors.js";
import type { McpConnectionLogin, McpConnectionRow, NewMcpConnection } from "../../src/db/mcp.js";
import { lookupProperties, settingsComplete, validateSettings } from "../../src/connectors/settings.js";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConnector, manifestTools, toolStartsOff } from "../../src/connectors/load.js";
import { CONNECTORS, installConnectors } from "../../src/connectors/index.js";
import { defaultSearchServer, isSearchable, storageHint } from "../../src/connectors/builder.js";
import { readBuilderSystemTemplate } from "../../src/conversation/templates.js";
import { CORE_INTEGRATIONS, integrationStatuses } from "../../src/instance/integrations.js";
import { composeSystemPrompt, connectorGuidance } from "../../src/prompts/index.js";
import { loadManifest, ManifestError } from "../../src/connectors/manifest.js";
import { ConnectorRegistry, ConnectorRegistryError } from "../../src/connectors/registry.js";
import { CORE_STATE_KEYS } from "../../src/state/index.js";
import { ConnectorError, type ConnectorContext, type ConnectorTool, type RemoteSession } from "../../src/connectors/types.js";
import drive from "../../src/connectors/drive/adapter.js";
import opensea from "../../src/connectors/opensea/adapter.js";
import { isReadOnlyRemote, ListedTool, McpError, McpPool, STATE_TIMEOUT_MS } from "../../src/mcp/index.js";
import { HEX_MASTER_KEY } from "../helpers/env.js";
import { mockFetch } from "../helpers/http.js";
import { QUOTES, WITH_QUOTES } from "../helpers/quotes.js";
import { endpointManifest } from "../helpers/registry.js";
import { serverRow } from "../helpers/servers.js";
import { connectionRow } from "../helpers/servers.js";

const KEY = decodeMasterKey(HEX_MASTER_KEY);

function remoteOf(overrides: Partial<RemoteSession> = {}): RemoteSession {
  return {
    initialize: async () => ({ name: "", instructions: "" }),
    list: async () => [],
    call: async () => "",
    ...overrides,
  };
}

function contextOf(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    http: mockFetch(() => ({ status: 500, json: {} })),
    remote: remoteOf(),
    connection_id: "conn_1",
    settings: {},
    ...overrides,
  };
}

const CONNECTORS_DIR = fileURLToPath(new URL("../../src/connectors/", import.meta.url));
const FOLDERS = readdirSync(CONNECTORS_DIR).filter((name) => statSync(path.join(CONNECTORS_DIR, name)).isDirectory());

test("every connector folder holds a valid manifest named after it, and the core list has it", () => {
  assert.equal(FOLDERS.length, CONNECTORS.entries().length);
  for (const folder of FOLDERS) {
    const raw = JSON.parse(readFileSync(path.join(CONNECTORS_DIR, folder, "connector.json"), "utf8")) as unknown;
    const manifest = loadManifest(raw, folder);
    const entry = CONNECTORS.bySlug(folder);
    assert.ok(entry, folder);
    assert.equal(entry.id, `mcp_${folder}`);
    assert.deepEqual(entry.manifest, manifest);
    assert.ok(manifest.endpoint || existsSync(path.join(CONNECTORS_DIR, folder, "adapter.ts")) || !manifest.tools?.length, folder);
  }
  assert.throws(() => loadManifest({ ...CONNECTORS.bySlug("qonto")!.manifest }, "other"), ManifestError);
});

test("a manifest declares a key or a client of its own within the rules", () => {
  const own = loadManifest(
    endpointManifest("acme", {
      auth: { kind: "token", fields: [{ name: "cert", label: "Certificate", multiline: true }], instance: { own: true } },
    }),
  );
  assert.deepEqual(own.auth.instance, { own: true });
  assert.equal(own.auth.fields?.[0]?.multiline, true);
  const configured = loadManifest(endpointManifest("portal", { auth: { kind: "oauth", oauth: { strategy: "configured" } } }));
  assert.equal(configured.auth.oauth?.provider, undefined);
  const shipped = loadManifest({
    ...endpointManifest("mail", { auth: { kind: "oauth", oauth: { strategy: "configured", provider: "google-connectors" } } }),
    endpoint: undefined,
  });
  assert.equal(shipped.auth.oauth?.provider, "google-connectors", "a provider brings its own discovery");
  const refused = (raw: Record<string, unknown>, pattern: RegExp) =>
    assert.throws(() => loadManifest(raw), (error: unknown) => error instanceof ManifestError && pattern.test(error.message));
  refused(
    endpointManifest("acme", { auth: { kind: "oauth", oauth: { strategy: "dynamic" }, instance: { own: true } } }),
    /connector acme declares a platform key of its own without token auth/,
  );
  refused(
    { ...endpointManifest("portal", { auth: { kind: "oauth", oauth: { strategy: "configured" } } }), endpoint: undefined },
    /connector portal signs in with a configured client of its own and needs an endpoint to discover its authorization server/,
  );
  refused(endpointManifest("acme", { auth: { kind: "token", instance: { own: false } } }), /auth\/instance/);
  refused(endpointManifest("acme", { auth: { kind: "token", instance: { integration: "web-search" } } }), /auth\/instance/);
  refused(endpointManifest("acme", { auth: { kind: "token", instance: { own: true, integration: "web-search", field: "api_key" } } }), /auth\/instance/);
  refused(endpointManifest("acme", { auth: { kind: "token", fields: [{ name: "k", label: "K", multiline: "yes" }] } }), /multiline/);
});

test("manifests keep their tools, endpoints, settings, and state within the rules", () => {
  for (const entry of CONNECTORS.entries()) {
    const { manifest, adapter } = entry;
    const names = (manifest.tools ?? []).map((tool) => tool.name);
    assert.equal(new Set(names).size, names.length, manifest.slug);
    for (const tool of manifest.tools ?? []) {
      assert.equal(tool.input_schema.type, "object", `${manifest.slug} ${tool.name}`);
    }
    if (manifest.endpoint) {
      assert.match(manifest.endpoint.url, /^https:\/\//, manifest.slug);
    }
    if (manifest.settings_schema) {
      assert.equal(manifest.settings_schema.type, "object", manifest.slug);
    }
    if (manifest.state) {
      assert.ok(!CORE_STATE_KEYS.has(manifest.state.key), manifest.slug);
    }
    assert.equal(Boolean(manifest.state), Boolean(adapter.state), manifest.slug);
    if (!manifest.endpoint && (adapter.list || manifest.tools?.length)) {
      assert.ok(adapter.call, manifest.slug);
    }
  }
  for (const entry of CONNECTORS.entries()) {
    const server = serverRow("custom", { id: entry.id, slug: entry.manifest.slug, tool_prefix: entry.manifest.slug });
    for (const tool of manifestTools(server)) {
      if (tool.mutating) {
        assert.equal(tool.default_enabled, false, `${entry.manifest.slug} ${tool.remote_name}`);
      }
    }
  }
});

test("an endpoint's headers are custom headers, each named once and apart from the credential's", () => {
  const withHeaders = (headers: Record<string, string>, auth: Record<string, unknown> = { kind: "token" }) =>
    endpointManifest("portal", { endpoint: { url: "https://mcp.example.com/mcp", headers }, auth });
  assert.deepEqual(loadManifest(withHeaders({ "X-Toolsets": "a,b" })).endpoint?.headers, { "X-Toolsets": "a,b" });
  for (const [headers, auth] of [
    [{ Accept: "text/plain" }, undefined],
    [{ "X-Toolsets": "a", "x-toolsets": "b" }, undefined],
    [{ "x-api-key": "other" }, { kind: "token", header: { name: "X-API-Key", prefix: "" } }],
  ] as const) {
    assert.throws(() => loadManifest(withHeaders(headers, auth)), ManifestError, JSON.stringify(headers));
  }
});

test("a connector row loads with its overrides applied over the manifest", () => {
  const notion = CONNECTORS.bySlug("notion")!;
  const row: ConnectorRow = {
    id: "mcp_notion",
    slug: "notion",
    tool_prefix: "notion",
    owner_org_id: null,
    manifest: notion.manifest,
    source: "core",
    version: "",
    verified: true,
    experimental: false,
    publisher: "guilds",
    enabled: false,
    oauth_client: { client_id: "c1", client_secret: null, redirect_uris: [] },
    overrides: { description: "Our wiki.", tools: { "notion-search": { default: true, description: "Search it." } } },
    installed_at: "2026-10-12T09:00:00.000Z",
    updated_at: "2026-10-12T09:00:00.000Z",
  };
  const server = loadConnector(row);
  assert.equal(server.description, "Our wiki.");
  assert.equal(server.enabled, false);
  assert.deepEqual(server.config, { url: "https://mcp.notion.com/mcp", oauth_client: { client_id: "c1", client_secret: null, redirect_uris: [] } });
  assert.equal(server.oauth_strategy, "dynamic");
  assert.equal(server.upstream.description, notion.manifest.description);
  assert.equal(toolStartsOff(server, "notion-search"), false);
  assert.equal(toolStartsOff(server, "notion-create-pages"), true);
  const qonto = loadConnector({ ...row, id: "mcp_qonto", slug: "qonto", manifest: CONNECTORS.bySlug("qonto")!.manifest, overrides: {} });
  assert.equal(toolStartsOff(qonto, "upload_invoice"), true);
  assert.equal(toolStartsOff(qonto, "list_bank_accounts"), false);
});

test("a logo is a 24x24 currentColor mark", () => {
  for (const folder of FOLDERS) {
    const file = path.join(CONNECTORS_DIR, folder, "logo.svg");
    if (existsSync(file)) {
      const svg = readFileSync(file, "utf8");
      assert.match(svg, /viewBox="0 0 24 24"/, folder);
      assert.match(svg, /currentColor/, folder);
      assert.doesNotMatch(svg, /<script|on[a-z]+=/i, folder);
    }
  }
});

test("the registry refuses an entry that cannot run", () => {
  const x = CONNECTORS.bySlug("x")!;
  assert.throws(() => new ConnectorRegistry([{ ...x, adapter: {} }]), ConnectorRegistryError);
  assert.throws(() => new ConnectorRegistry([{ ...QUOTES, adapter: {} }]), /no state hook/);
  const notion = CONNECTORS.bySlug("notion")!;
  assert.throws(() => new ConnectorRegistry([{ ...notion, adapter: { state: async () => 1 } }]), /no state in its manifest/);
  assert.throws(() => CONNECTORS.with([x]), /registered twice/);
});

test("the registry finds a server row by id, then by slug", () => {
  assert.equal(CONNECTORS.forServer({ id: "mcp_qonto", slug: "other" })?.manifest.slug, "qonto");
  assert.equal(CONNECTORS.forServer(serverRow("qonto"))?.manifest.slug, "qonto");
  assert.equal(CONNECTORS.forServer({ id: "mcp_custom", slug: "custom" }), null);
});

test("Drive's listing rewrites the two byte tools", async () => {
  const listed = await drive.list!({}, contextOf({
    remote: remoteOf({
      list: async () => [
        { name: "create_file", description: "base64", input_schema: {} },
        { name: "download_file_content", description: "base64", input_schema: {} },
        { name: "search_files", description: "search", input_schema: { type: "object" } },
      ],
    }),
  }));
  assert.match(listed[0]!.description, /file_path/);
  assert.match(listed[1]!.description, /file_path/);
  assert.deepEqual(listed[2], { name: "search_files", description: "search", input_schema: { type: "object" } });
});

test("Drive runs its file tools itself and forwards the rest inside the folder", async () => {
  const forwarded: Array<[string, Record<string, unknown>]> = [];
  const urls: string[] = [];
  const ctx = contextOf({
    settings: { folder_id: "folder_1" },
    http: mockFetch((url) => {
      urls.push(url);
      return { status: 200, json: { files: [] } };
    }),
    remote: remoteOf({
      call: async (name, args) => {
        forwarded.push([name, args]);
        return "remote";
      },
    }),
  });
  const recent = await drive.call!("list_recent_files", {}, { access_token: "ya29" }, ctx);
  assert.equal(recent, JSON.stringify({ files: [] }));
  assert.ok(urls.every((url) => url.startsWith("https://www.googleapis.com/drive/v3/files")));
  assert.equal(forwarded.length, 0);
  assert.equal(await drive.call!("get_drive_info", { verbose: true }, { access_token: "ya29" }, ctx), "remote");
  assert.deepEqual(forwarded, [["get_drive_info", { verbose: true }]]);
});

test("Drive refuses a call with no folder and folder errors are 422", async () => {
  await assert.rejects(
    () => drive.call!("search_files", {}, { access_token: "ya29" }, contextOf()),
    (error: unknown) => error instanceof ConnectorError && error.status === 422,
  );
  await assert.rejects(
    () =>
      drive.call!(
        "search_files",
        { query: "not 'folder_1' in parents" },
        { access_token: "ya29" },
        contextOf({ settings: { folder_id: "folder_1" } }),
      ),
    (error: unknown) => error instanceof ConnectorError && error.status === 422,
  );
});

test("OpenSea's validate rejects a key that lists only the instant-key tool", async () => {
  const listing = (names: string[]) =>
    contextOf({
      remote: remoteOf({
        list: async () => names.map((name): ConnectorTool => ({ name, description: "", input_schema: {} })),
      }),
    });
  await assert.rejects(
    () => opensea.validate!({ token: "bad" }, listing(["get_instant_api_key"])),
    (error: unknown) => error instanceof ConnectorError && error.status === 401,
  );
  assert.equal(await opensea.validate!({ token: "ok" }, listing(["get_instant_api_key", "search"])), "");
});

test("a REST adapter's upstream 401 reaches the pool as an McpError", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const pool = new McpPool();
  pool.fetchFn = mockFetch(() => ({ status: 401, json: { error: "invalid key" } }));
  const [ciphertext, nonce] = encryptPayload({ token: "bad" }, KEY);
  const db = { async listMcpTools() { return []; }, async replaceMcpTools() { return; } };
  await assert.rejects(
    () =>
      pool.syncTools(db as never, connectionRow({ id: "conn_cg", status: "connected", ciphertext, nonce }), serverRow("coingecko", { id: "mcp_coingecko", auth: "token" }), { force: true }),
    (error: unknown) => error instanceof McpError && error.status === 401,
  );
});

test("validate checks credentials before a login exists", async () => {
  const pool = new McpPool();
  pool.connectors = CONNECTORS.withAdapter("qonto", {
    async validate(creds: Record<string, string>) {
      assert.deepEqual(creds, { login: "org", secret_key: "secret" });
      return "Elektro";
    },
  });
  assert.equal(await pool.validate(serverRow("qonto", { id: "mcp_qonto" }), { login: "org", secret_key: "secret" }), "Elektro");
  pool.connectors = CONNECTORS.withAdapter("qonto", {
    async validate() {
      throw new ConnectorError("bad key", 401);
    },
  });
  await assert.rejects(
    () => pool.validate(serverRow("qonto", { id: "mcp_qonto" }), {}),
    (error: unknown) => error instanceof McpError && error.status === 401 && error.message === "bad key",
  );
});

test("lookup runs the adapter's search with the form's credentials", async () => {
  const pool = new McpPool();
  pool.connectors = WITH_QUOTES;
  pool.fetchFn = mockFetch((url, init) => {
    assert.match(url, /\/search\?query=eth$/);
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer qk");
    return { status: 200, json: { results: [{ id: "ethereum", name: "Ethereum" }] } };
  });
  const options = await pool.lookup(serverRow("quotes", { id: "mcp_quotes" }), "symbols", "eth", { token: "qk" });
  assert.deepEqual(options, [{ value: { id: "ethereum", name: "Ethereum" }, label: "Ethereum" }]);
  await assert.rejects(
    () => pool.lookup(serverRow("qonto", { id: "mcp_qonto" }), "symbols", "eth", {}),
    (error: unknown) => error instanceof McpError && error.status === 404,
  );
});

test("a listed tool carries the endpoint's annotations", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const pool = new McpPool();
  const seen: ConnectorTool[] = [];
  pool.connectors = CONNECTORS.withAdapter("notion", {
    async list(_creds, ctx) {
      seen.push(...(await ctx.remote.list()));
      return seen;
    },
  });
  pool.session = async () =>
    ({
      async listTools() {
        return [
          { name: "search", description: "", inputSchema: {}, annotations: { readOnlyHint: true } },
          { name: "delete_page", description: "", inputSchema: {}, annotations: { destructiveHint: true } },
        ];
      },
    }) as never;
  const db = { async listMcpTools() { return []; }, async replaceMcpTools() { return; }, async insertBindingIfAbsent() {} };
  const listed = await pool.syncTools(db as never, connectionRow({ id: "conn_n", status: "connected" }), serverRow("notion", { id: "mcp_notion", auth: "token" }));
  assert.deepEqual(listed.map((tool) => tool.namespaced_name), ["notion_search", "notion_delete_page"]);
  assert.deepEqual(
    seen.map((tool) => [tool.read_only_hint, tool.destructive_hint]),
    [[true, null], [null, true]],
  );
});

function stateDb(connection: Record<string, unknown>) {
  return {
    listBindingsCovering: async () => [
      {
        catalog_kind: "mcp",
        catalog_id: "mcp_quotes",
        scope: "org",
        scope_id: "org_1",
        enabled: true,
        connection_id: "conn_pins",
      },
    ],
    listAgentSecrets: async () => [],
    listMcpServers: async () => [{ id: "mcp_quotes", slug: "quotes", auth: "token" }],
    listMcpConnections: async () => [{ id: "conn_pins", status: "connected", settings: {}, ...connection }],
    listMcpTools: async () => [],
  };
}

const AGENT = { id: "agent_1", guild_id: "guild_1", org_id: "org_1" };
const PINNED = [{ id: "ethereum", name: "Ethereum" }];

test("state quotes pinned symbols under the manifest's key and redacts the key", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const [ciphertext, nonce] = encryptPayload({ token: "qk-secret" }, KEY);
  const pool = new McpPool();
  pool.connectors = WITH_QUOTES;
  pool.fetchFn = mockFetch(() => ({ status: 200, json: { ethereum: 3200 } }));
  const state = await pool.state(stateDb({ ciphertext, nonce, settings: { symbols: PINNED } }) as never, AGENT);
  assert.deepEqual(state, { quotes: [{ id: "ethereum", price: 3200 }] });
  pool.connectors = WITH_QUOTES.withAdapter("quotes", { state: async (creds) => ({ leaked: creds.token }) });
  assert.deepEqual(await pool.state(stateDb({ ciphertext, nonce }) as never, AGENT), {
    quotes: { leaked: "[REDACTED:token]" },
  });
});

test("state is redacted against a login's secrets, not the rest of its payload", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const [ciphertext, nonce] = encryptPayload({ token: "qk-secret", access_token: "at-secret", account: "acme" }, KEY);
  const pool = new McpPool();
  pool.connectors = WITH_QUOTES.withAdapter("quotes", {
    state: async (creds) => ({ owner: creds.account, token: creds.token, access: creds.access_token }),
  });
  assert.deepEqual(await pool.state(stateDb({ ciphertext, nonce }) as never, AGENT), {
    quotes: { owner: "acme", token: "[REDACTED:token]", access: "[REDACTED:access_token]" },
  });
});

test("state leaves out a login with no value and marks a failing hook unavailable", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const [ciphertext, nonce] = encryptPayload({ token: "qk" }, KEY);
  const pool = new McpPool();
  pool.connectors = WITH_QUOTES;
  assert.deepEqual(await pool.state(stateDb({ ciphertext, nonce }) as never, AGENT), {});
  pool.connectors = WITH_QUOTES.withAdapter("quotes", {
    state: async () => {
      throw new ConnectorError("quota exhausted", 429);
    },
  });
  assert.deepEqual(await pool.state(stateDb({ ciphertext, nonce }) as never, AGENT), {
    quotes: { unavailable: "quota exhausted" },
  });
  pool.connectors = WITH_QUOTES.withAdapter("quotes", { state: async () => "x".repeat(40_000) });
  const big = await pool.state(stateDb({ ciphertext, nonce }) as never, AGENT);
  assert.match(String((big.quotes as { unavailable: string }).unavailable), /exceeds/);
});

test("a state hook that outlives the budget yields unavailable", async (t) => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const [ciphertext, nonce] = encryptPayload({ token: "qk" }, KEY);
  const pool = new McpPool();
  pool.connectors = WITH_QUOTES.withAdapter("quotes", { state: () => new Promise(() => undefined) });
  const pending = pool.state(stateDb({ ciphertext, nonce }) as never, AGENT);
  for (let tick = 0; tick < 20; tick += 1) {
    await Promise.resolve();
  }
  t.mock.timers.tick(STATE_TIMEOUT_MS);
  assert.deepEqual(await pending, { quotes: { unavailable: `timed out after ${STATE_TIMEOUT_MS} ms` } });
});

class ConnectRepoStub {
  rows = new Map<string, McpConnectionRow>();
  tools: ListedTool[] = [];

  async getMcpConnectionForOwner(serverId: string, ownerScope: string, ownerId: string | null) {
    return this.rows.get(`${serverId}:${ownerScope}:${ownerId}`) ?? null;
  }

  async connectMcp(input: NewMcpConnection, now: Date) {
    const stamp = now.toISOString();
    const row = {
      id: input.connectionId,
      mcp_server_id: input.serverId,
      owner_scope: input.ownerScope,
      owner_id: input.ownerId,
      ciphertext: input.ciphertext,
      nonce: input.nonce,
      status: input.status ?? "pending",
      account_hint: input.accountHint ?? "",
      oauth_state: input.oauthState ?? null,
      settings: input.settings ?? {},
      created_at: stamp,
      updated_at: stamp,
      rotated_at: stamp,
    };
    this.rows.set(`${input.serverId}:${input.ownerScope}:${input.ownerId}`, row);
    return row;
  }

  async deleteMcpConnection(connectionId: string) {
    for (const [key, row] of this.rows) {
      if (row.id === connectionId) this.rows.delete(key);
    }
  }

  async saveMcpConnection(connectionId: string, options: Pick<McpConnectionLogin, "status">) {
    for (const row of this.rows.values()) {
      if (row.id === connectionId) row.status = options.status;
    }
    return null;
  }

  async listMcpTools() {
    return [];
  }

  async replaceMcpTools(_id: string, tools: ListedTool[]) {
    this.tools = tools;
  }
}

const QONTO = serverRow("qonto", { display_name: "Qonto" });
const X_SERVER = serverRow("x", { display_name: "X" });

test("connect stores a two-field login under the manifest's names with the validated hint", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const repo = new ConnectRepoStub();
  const pool = new McpPool();
  pool.connectors = CONNECTORS.withAdapter("qonto", { validate: async () => "Elektro" });
  const { connection, outcome } = await connect(
    repo as never,
    pool,
    { server: QONTO, ownerScope: "org", ownerId: "org_1", credentials: { login: " org ", secret_key: "s3", extra: "x" } },
    new Date(),
    { masterKey: KEY },
  );
  assert.equal(outcome, "installed");
  assert.equal(connection.account_hint, "Elektro");
  assert.deepEqual(decryptPayload(connection.ciphertext, connection.nonce, KEY), {
    login: "org",
    secret_key: "s3",
  });
  assert.deepEqual(
    repo.tools.map((tool) => tool.remote_name),
    CONNECTORS.bySlug("qonto")!.manifest.tools!.map((tool) => tool.name),
  );
  await assert.rejects(
    () => connect(repo as never, pool, { server: QONTO, ownerScope: "org", ownerId: "org_2", credentials: { login: "org" } }),
    (error: unknown) => error instanceof ConnectError && error.status === 422 && error.message === "secret key is required",
  );
});

test("connect refuses, keeps, or replaces an owner's login as asked", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const repo = new ConnectRepoStub();
  const pool = new McpPool();
  pool.connectors = CONNECTORS.withAdapter("x", { validate: async () => "" });
  const owner = { server: X_SERVER, ownerScope: "org", ownerId: "org_1" } satisfies Partial<ConnectInput>;
  const first = await connect(repo as never, pool, { ...owner, credentials: { token: "one" }, accountHint: "plan" }, new Date(), { masterKey: KEY });
  assert.equal(first.outcome, "installed");
  await assert.rejects(
    () => connect(repo as never, pool, { ...owner, credentials: { token: "two" } }, new Date(), { masterKey: KEY }),
    (error: unknown) => error instanceof ConnectError && error.status === 409,
  );
  const kept = await connect(repo as never, pool, { ...owner, credentials: { token: "two" }, onExisting: "keep" }, new Date(), { masterKey: KEY });
  assert.equal(kept.outcome, "kept");
  const current = await connect(
    repo as never,
    pool,
    { ...owner, credentials: { token: "one" }, onExisting: { replace_when_hint: "plan" } },
    new Date(),
    { masterKey: KEY },
  );
  assert.equal(current.outcome, "current");
  const replaced = await connect(
    repo as never,
    pool,
    { ...owner, credentials: { token: "two" }, onExisting: { replace_when_hint: "plan" }, accountHint: "plan" },
    new Date(),
    { masterKey: KEY },
  );
  assert.equal(replaced.outcome, "installed");
  const other = await connect(
    repo as never,
    pool,
    { ...owner, credentials: { token: "three" }, onExisting: { replace_when_hint: "someone else" } },
    new Date(),
    { masterKey: KEY },
  );
  assert.equal(other.outcome, "kept");
});

test("connect answers a rejected key with a 422 and stores nothing", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const repo = new ConnectRepoStub();
  const pool = new McpPool();
  pool.connectors = CONNECTORS.withAdapter("x", {
    validate: async () => {
      throw new ConnectorError("Unauthorized", 401);
    },
  });
  await assert.rejects(
    () => connect(repo as never, pool, { server: X_SERVER, ownerScope: "org", ownerId: "org_1", credentials: { token: "bad" } }),
    (error: unknown) => error instanceof ConnectError && error.status === 422 && error.message === "api key was rejected",
  );
  assert.equal(repo.rows.size, 0);
});

test("the builder names searchable workspaces and systems of record from manifests", () => {
  const template = readBuilderSystemTemplate();
  assert.doesNotMatch(template, /\{\{[A-Z_]+\}\}/);
  assert.match(template, /searchable workspace\s+\(Notion\)/);
  assert.match(template, /- Notion: Its pages and databases/);
  assert.equal(defaultSearchServer(), "notion");
  assert.equal(isSearchable("mcp_notion"), true);
  assert.equal(isSearchable("gmail"), false);
  assert.match(storageHint(), /such as Notion hold long-lived records/);
});

test("a connector's prompt guidance renders only when its tools are offered", () => {
  const notion = CONNECTORS.bySlug("notion")!;
  const guided = { ...notion, id: "mcp_guided", manifest: { ...notion.manifest, slug: "guided", prompt: { guidance: "Cite the page you read." } } };
  installConnectors([guided]);
  try {
    assert.deepEqual(connectorGuidance(["guided"]), ["Cite the page you read."]);
    assert.deepEqual(connectorGuidance(["notion"]), []);
    const prompt = composeSystemPrompt("Be brief.", "Work.", {}, "", undefined, connectorGuidance(["guided"]));
    assert.match(prompt, /<guidelines>\nBe brief\.\n\nCite the page you read\.\n<\/guidelines>/);
  } finally {
    installConnectors([]);
  }
});

test("an integration lists the connectors whose manifests require it", () => {
  const statuses = integrationStatuses(CORE_INTEGRATIONS, {});
  assert.deepEqual(statuses.find((item) => item.id === "google-connectors")?.provides.connectors, ["gmail", "drive"]);
  assert.deepEqual(statuses.find((item) => item.id === "github-app")?.provides.connectors, ["github"]);
});

test("settings are checked against the manifest's schema", () => {
  const schema = QUOTES.manifest.settings_schema!;
  assert.deepEqual(validateSettings(schema, { symbols: [{ id: "bitcoin" }] }), { symbols: [{ id: "bitcoin" }] });
  assert.throws(() => validateSettings(schema, {}), /settings.symbols is required/);
  assert.throws(() => validateSettings(schema, { symbols: [] }), /at least 1/);
  assert.throws(() => validateSettings(schema, { symbols: [{ id: "Bad Id" }] }), /must match/);
  assert.throws(() => validateSettings(schema, { symbols: [{ id: "x" }], extra: 1 }), /not a setting/);
  assert.equal(settingsComplete(schema, {}), false);
  assert.equal(settingsComplete(schema, { symbols: [] }), true);
  assert.equal(settingsComplete(undefined, {}), true);
  assert.deepEqual(lookupProperties(schema), ["symbols"]);
  assert.deepEqual(lookupProperties(CONNECTORS.bySlug("drive")!.manifest.settings_schema), ["folder_id"]);
});

test("connect stores a login that lacks required settings as pending, and one with them as connected", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const repo = new ConnectRepoStub();
  const pool = new McpPool();
  const seen: Array<Record<string, unknown>> = [];
  pool.connectors = WITH_QUOTES.withAdapter("quotes", {
    async validate(_creds, ctx) {
      seen.push({ ...ctx.settings });
      return "1 symbol";
    },
  });
  const server = serverRow("quotes", { id: "mcp_quotes", auth: "token", display_name: "Quotes" });
  const waiting = await connect(repo as never, pool, { server, ownerScope: "org", ownerId: "org_1", credentials: { token: "qk" } }, new Date(), { connectors: WITH_QUOTES });
  assert.equal(waiting.connection.status, "pending");
  assert.deepEqual(repo.tools, []);
  const ready = await connect(repo as never, pool, {
    server,
    ownerScope: "org",
    ownerId: "org_2",
    credentials: { token: "qk" },
    settings: { symbols: [{ id: "bitcoin" }] },
  }, new Date(), { connectors: WITH_QUOTES });
  assert.equal(ready.connection.status, "connected");
  assert.deepEqual(seen, [{}, { symbols: [{ id: "bitcoin" }] }]);
  await assert.rejects(
    () =>
      connect(repo as never, pool, {
        server,
        ownerScope: "org",
        ownerId: "org_3",
        credentials: { token: "qk" },
        settings: { symbols: "bitcoin" },
      }, new Date(), { connectors: WITH_QUOTES }),
    (error: unknown) => error instanceof ConnectError && error.status === 422,
  );
});

test("a listed tool the manifest does not name starts by its annotations and its name", () => {
  const server = serverRow("acme", { id: "mcp_acme", tool_prefix: "acme" });
  assert.equal(toolStartsOff(server, "search_orders"), false);
  assert.equal(toolStartsOff(server, "search_orders", { destructiveHint: false }), false);
  assert.equal(toolStartsOff(server, "search_orders", { destructiveHint: true }), true);
  assert.equal(toolStartsOff(server, "cancelOrder"), true);
  assert.equal(toolStartsOff(server, "delete-page"), true);
  const edited = serverRow("custom", { ...server, overrides: { tools: { cancelOrder: { default: true }, search_orders: { default: false } } } });
  assert.equal(toolStartsOff(edited, "cancelOrder"), false);
  assert.equal(toolStartsOff(edited, "search_orders"), true);
  const opensea = serverRow("opensea", { id: "mcp_opensea", tool_prefix: "opensea" });
  assert.equal(toolStartsOff(opensea, "get_favorites"), true);
  assert.equal(toolStartsOff(opensea, "search"), false);
});

test("Studio trusts readOnlyHint only on a verified connector", () => {
  assert.equal(isReadOnlyRemote("acme", "cancel_order", { readOnlyHint: true, verified: true }), true);
  assert.equal(isReadOnlyRemote("acme", "cancel_order", { readOnlyHint: true, verified: false }), false);
  assert.equal(isReadOnlyRemote("acme", "list_orders", { readOnlyHint: null, verified: false }), true);
  assert.equal(isReadOnlyRemote("opensea", "get_favorites", { readOnlyHint: true, verified: true }), false);
});

test("a sync keeps each listed tool's annotations", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const pool = new McpPool();
  pool.session = async () =>
    ({
      async listTools() {
        return [
          { name: "find", description: "", inputSchema: {}, annotations: { readOnlyHint: true } },
          { name: "wipe", description: "", inputSchema: {}, annotations: { destructiveHint: true } },
        ];
      },
    }) as never;
  const stored: ListedTool[] = [];
  const overlays: string[] = [];
  const db = {
    async listMcpTools() {
      return [];
    },
    async replaceMcpTools(_id: string, tools: ListedTool[]) {
      stored.push(...tools);
    },
    async insertBindingIfAbsent(input: { catalogId: string }) {
      overlays.push(input.catalogId);
      return {};
    },
  };
  await pool.syncTools(
    db as never,
    connectionRow({ id: "conn_acme", status: "connected", owner_scope: "org", owner_id: "org_1" }),
    serverRow("acme", { id: "mcp_acme", tool_prefix: "acme", auth: "token" }),
  );
  assert.deepEqual(
    stored.map((tool) => [tool.remote_name, tool.read_only_hint, tool.destructive_hint]),
    [["find", true, null], ["wipe", null, true]],
  );
  assert.deepEqual(overlays, ["acme_wipe"]);
});

test("GitHub's State names the repositories a login picked as the owner and repo its tools take", async () => {
  const github = CONNECTORS.bySlug("github")!;
  const settings = {
    repositories: [
      { name: "shop", url: "https://github.com/acme/shop", default_branch: "main", github_id: 101 },
      { name: "docs", url: "https://github.com/acme/docs.git", default_branch: "trunk" },
    ],
  };
  assert.equal(github.manifest.state?.key, "github_repositories");
  assert.deepEqual(await github.adapter.state!({}, contextOf({ settings })), [
    { owner: "acme", repo: "shop", default_branch: "main" },
    { owner: "acme", repo: "docs", default_branch: "trunk" },
  ]);
  assert.equal(await github.adapter.state!({}, contextOf({ settings: {} })), null, "a login with none picked adds no key");
});
