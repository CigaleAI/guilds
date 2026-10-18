import assert from "node:assert/strict";
import { after, test } from "node:test";
import { persistAgent } from "../../src/agents/persist.js";
import { persistGuild } from "../../src/guilds/persist.js";
import { buildApp } from "../../src/app.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import { connect } from "../../src/db/client.js";
import { Repositories } from "../../src/db/repositories.js";
import { seedSystem } from "../../src/db/seed/system.js";
import { newId } from "../../src/lib/ids.js";
import { NotesStore } from "../../src/notes/store.js";
import { Scripts } from "../../src/scripts/catalog.js";
import { Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { limitedPolicy } from "../helpers/policy.js";
import {
  createIsolatedDatabase,
  dropIsolatedDatabase,
  uniqueDbName,
} from "../helpers/postgres.js";

const AUTH = {
  "X-Guilds-User": "user_operator",
  "X-Guilds-Org": "org_home",
};

const dbName = uniqueDbName("agent_platform_mcp_catalog");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("admin catalog, overrides, seed preservation, listed tools, and leaks", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const databaseUrl = await createIsolatedDatabase(dbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-catalog-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool);
  const app = await buildApp(database, {
    repo,
    notes,
    scripts: new Scripts(repo),
    schedules: new Schedules(repo),
    policy: limitedPolicy({ maxAgents: 25, maxBrowserAgents: 10, maxCodingAgents: 10 }),
  });

  const outsider = await repo.insertUser("user_other", "other", new Date(), null, "other@example.com");
  await repo.insertMember("org_home", String(outsider.id), "member", new Date());

  const denied = await app.inject({
    method: "GET",
    url: "/api/admin/mcp/servers",
    headers: { "X-Guilds-User": String(outsider.id), "X-Guilds-Org": "org_home" },
  });
  assert.equal(denied.statusCode, 404);

  const listed = await app.inject({ method: "GET", url: "/api/admin/mcp/servers", headers: AUTH });
  assert.equal(listed.statusCode, 200);
  const servers = listed.json().servers as Array<Record<string, unknown>>;
  assert.ok(servers.some((row) => row.slug === "notion" && row.description));
  const notion = servers.find((row) => row.slug === "notion") as Record<string, unknown>;
  const coingecko = servers.find((row) => row.slug === "coingecko") as Record<string, unknown>;
  assert.ok(Array.isArray(coingecko.tools) && (coingecko.tools as unknown[]).length > 0);
  const github = servers.find((row) => row.slug === "github") as Record<string, unknown>;
  assert.equal(github.display_name, "GitHub");
  assert.deepEqual(github.tools, []);
  assert.equal(servers.find((row) => row.slug === "tavily")?.display_name, "Web search");
  assert.equal(JSON.stringify(listed.json()).includes("oauth_client"), false);

  const patched = await app.inject({
    method: "PATCH",
    url: `/api/admin/mcp/servers/${notion.id}`,
    headers: { ...AUTH, "content-type": "application/json" },
    payload: { description: "Admin-authored Notion copy", limitations: "Admin limitation" },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().description, "Admin-authored Notion copy");
  assert.deepEqual(patched.json().overridden, ["description", "limitations"]);
  assert.notEqual(patched.json().upstream.description, "Admin-authored Notion copy");
  const endpoint = await app.inject({
    method: "PATCH",
    url: `/api/admin/mcp/servers/${notion.id}`,
    headers: { ...AUTH, "content-type": "application/json" },
    payload: { url: "https://example.com/mcp" },
  });
  assert.equal(endpoint.statusCode, 422);

  await repo.updateMcpServerConfig(
    String(notion.id),
    { url: "https://mcp.notion.com/mcp", oauth_client: { client_id: "keep-me" } },
    new Date(),
  );
  await seedSystem(database.pool);
  const afterSeed = await repo.getMcpServer(String(notion.id));
  assert.equal(afterSeed?.description, "Admin-authored Notion copy");
  const cleared = await app.inject({
    method: "PATCH",
    url: `/api/admin/mcp/servers/${notion.id}`,
    headers: { ...AUTH, "content-type": "application/json" },
    payload: { limitations: null },
  });
  assert.deepEqual(cleared.json().overridden, ["description"]);
  const config = afterSeed?.config as { oauth_client?: { client_id?: string } };
  assert.equal(config.oauth_client?.client_id, "keep-me");

  const created = await app.inject({
    method: "POST",
    url: "/api/admin/mcp/servers",
    headers: { ...AUTH, "content-type": "application/json" },
    payload: {
      slug: "linear",
      display_name: "Linear",
      auth: "oauth",
      oauth_strategy: "dynamic",
      url: "https://mcp.linear.app/mcp",
      description: "Issues and projects in Linear.",
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().slug, "linear");
  assert.equal(created.json().tool_prefix, "linear");
  assert.equal(created.json().source, "local");
  assert.equal(created.json().enabled, true);
  assert.equal(created.json().editable, "fields");
  const exported = await app.inject({
    method: "GET",
    url: `/api/admin/mcp/servers/${created.json().id}/export`,
    headers: AUTH,
  });
  assert.equal(exported.json().endpoint.url, "https://mcp.linear.app/mcp");
  assert.equal(exported.json().auth.oauth.strategy, "dynamic");

  const rejected = await app.inject({
    method: "POST",
    url: "/api/admin/mcp/servers",
    headers: { ...AUTH, "content-type": "application/json" },
    payload: {
      slug: "intranet",
      display_name: "Intranet",
      auth: "token",
      url: "https://10.0.0.8/mcp",
    },
  });
  assert.equal(rejected.statusCode, 422);

  const reserved = await app.inject({
    method: "POST",
    url: "/api/admin/mcp/servers",
    headers: { ...AUTH, "content-type": "application/json" },
    payload: {
      slug: "browser",
      display_name: "Browser",
      auth: "none",
      url: "https://example.com/mcp",
    },
  });
  assert.equal(reserved.statusCode, 422);

  const tool = await app.inject({
    method: "PATCH",
    url: `/api/admin/mcp/servers/${created.json().id}/tools/list_issues`,
    headers: { ...AUTH, "content-type": "application/json" },
    payload: { default: true, description: "List Linear issues." },
  });
  assert.equal(tool.statusCode, 200, tool.body);
  const issues = (tool.json().tools as Array<Record<string, unknown>>).find((row) => row.remote_name === "list_issues");
  assert.equal(issues?.namespaced_name, "linear_list_issues");
  assert.equal(issues?.default_enabled, true);
  assert.equal(issues?.default_override, true);

  const search = await app.inject({
    method: "GET",
    url: "/api/builder/capabilities/search?q=linear",
    headers: AUTH,
  });
  assert.equal(search.statusCode, 200);
  const hits = search.json().hits as Array<Record<string, unknown>>;
  assert.ok(hits.some((hit) => hit.server === "linear" && hit.tool === null));

  const linkedin = await app.inject({
    method: "GET",
    url: "/api/builder/capabilities/search?q=linkedin",
    headers: AUTH,
  });
  assert.equal(linkedin.statusCode, 200);
  assert.equal(
    (linkedin.json().hits as Array<Record<string, unknown>>).some((hit) => hit.server === "linkedin"),
    false,
  );

  const overview = await app.inject({ method: "GET", url: "/api/builder/capabilities", headers: AUTH });
  assert.equal(overview.statusCode, 200);
  const body = overview.json() as Record<string, unknown>;
  assert.ok(Array.isArray(body.native));
  assert.ok(Array.isArray(body.catalog));
  const dumped = JSON.stringify(body);
  assert.equal(dumped.includes("ciphertext"), false);
  assert.equal(dumped.includes("oauth_client"), false);
  assert.equal(dumped.includes("account_hint"), false);
  assert.equal(dumped.includes("keep-me"), false);
  const notionCard = (body.catalog as Array<Record<string, unknown>>).find((row) => row.slug === "notion");
  assert.equal(notionCard?.connection_state, "registered_not_connected");
  assert.ok(!("id" in (notionCard ?? {})));

  const described = await app.inject({
    method: "GET",
    url: "/api/builder/servers/coingecko",
    headers: AUTH,
  });
  assert.equal(described.statusCode, 200);
  assert.equal(described.json().slug, "coingecko");
  assert.ok((described.json().tools as unknown[]).length > 0);

  const access = await app.inject({ method: "GET", url: "/api/access", headers: AUTH });
  assert.equal(access.statusCode, 200);
  const mcp = access.json().mcp as Array<Record<string, unknown>>;
  const coingeckoAccess = mcp.find((row) => row.slug === "coingecko");
  assert.ok(coingeckoAccess?.description);
  assert.ok(Array.isArray(coingeckoAccess?.tools) && (coingeckoAccess?.tools as unknown[]).length > 0);
  const tools = access.json().tools as Array<Record<string, unknown>>;
  assert.ok(!tools.some((row) => row.name === "tavily_search"));
  assert.ok(mcp.some((row) => row.slug === "tavily"));

  const [ciphertext, nonce] = encryptPayload({ token: "coingecko-test" }, Buffer.from(HEX_MASTER_KEY, "hex"));
  const connection = await repo.connectMcp(
    newId("conn"),
    newId("bind"),
    String(coingecko.id),
    "org",
    "org_home",
    ciphertext,
    nonce,
    new Date(),
    { status: "connected" },
  );
  await repo.replaceMcpTools(
    String(connection.id),
    [
      {
        remote_name: "secret_probe",
        namespaced_name: "coingecko_secret_probe",
        description: "runtime only",
        input_schema: { type: "object" },
      },
    ],
    new Date(),
  );
  const listedHit = await app.inject({
    method: "GET",
    url: "/api/builder/capabilities/search?q=secret_probe",
    headers: AUTH,
  });
  const probe = (listedHit.json().hits as Array<Record<string, unknown>>).find(
    (hit) => hit.remote_name === "secret_probe",
  );
  assert.equal(probe?.tool, "coingecko_secret_probe");
  assert.equal(probe?.default_enabled, true);
  const elsewhere = await repo.insertOrg("org_elsewhere", "elsewhere", "elsewhere", "user_operator", new Date());
  const otherOrg = await app.inject({
    method: "GET",
    url: "/api/builder/capabilities/search?q=secret_probe",
    headers: { ...AUTH, "X-Guilds-Org": String(elsewhere.id) },
  });
  assert.equal(
    (otherOrg.json().hits as Array<Record<string, unknown>>).some((hit) => hit.remote_name === "secret_probe"),
    false,
  );

  const off = await app.inject({
    method: "PATCH",
    url: `/api/admin/mcp/servers/${created.json().id}`,
    headers: { ...AUTH, "content-type": "application/json" },
    payload: { enabled: false },
  });
  assert.equal(off.json().enabled, false);
  const withoutLinear = await app.inject({ method: "GET", url: "/api/builder/capabilities", headers: AUTH });
  assert.ok(!(withoutLinear.json().catalog as Array<Record<string, unknown>>).some((row) => row.slug === "linear"));

  const remaining = body.remaining as { agents: number; browser_agents: number };
  assert.equal(remaining.agents, 25);
  const now = new Date();
  await persistGuild(repo, notes, {
    guildId: "guild_catalog",
    name: "catalog-guild",
    now,
    orgId: "org_home",
    orgSlug: "home",
    about: "",
    creatorUserId: "user_operator",
  });
  await persistAgent(repo, notes, {
    agentId: "a_catalog",
    guildId: "guild_catalog",
    guildName: "catalog-guild",
    orgSlug: "home",
    orgId: "org_home",
    name: "catalog-agent",
    focus: "",
    config: {
      model: "openrouter/openai/gpt-5.6-luna",
      temperature: 1,
      max_tokens: 8192,
      max_steps: 30,
      max_tool_calls: 50,
      max_input_tokens: 100000,
      browser: false,
    },
    now,
  });
  const afterAgent = await app.inject({ method: "GET", url: "/api/builder/capabilities", headers: AUTH });
  assert.equal((afterAgent.json().remaining as { agents: number }).agents, 24);

  await app.close();
  await database.close();
});
