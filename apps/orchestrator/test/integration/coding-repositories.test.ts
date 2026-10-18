import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { decryptPayload } from "../../src/credentials/crypto.js";
import { connect } from "../../src/db/client.js";
import { Repositories } from "../../src/db/repositories.js";
import { NotesStore } from "../../src/notes/store.js";
import { Scripts } from "../../src/scripts/catalog.js";
import { Schedules } from "../../src/schedules/service.js";
import { setInstanceKeys } from "../../src/instance/integrations.js";
import { HEX_MASTER_KEY, storeKeys, tempDir } from "../helpers/env.js";
import { connectModelProvider } from "../helpers/models.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { codeDefaultMachine } from "../helpers/machines.js";

const OWNER = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const JSON_HEADERS = { ...OWNER, "content-type": "application/json" };
const dbName = uniqueDbName("agent_platform_coding_repositories");
/** The box's GitHub App, as the instance admin stored it. */
const APP_KEYS = {
  app_id: "4242",
  slug: "guilds-run-test",
  private_key: generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString(),
  client_id: "Iv1.client",
  client_secret: "client-secret",
};

after(async () => {
  await dropIsolatedDatabase(dbName);
});

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The `redirect_uri` of each code GitHub was asked to trade, in order. */
const exchangedRedirects: Array<string | undefined> = [];

/**
 * GitHub as the App sees it: one user who installed the App on `acme` (installation 77), and one
 * (`fresh-code`) who has not installed it yet.
 */
function github(url: string, init: RequestInit = {}): Response {
  const parsed = new URL(url);
  if (parsed.host === "github.com" && parsed.pathname === "/login/oauth/access_token") {
    const body = JSON.parse(String(init.body)) as { code: string; client_secret: string; redirect_uri?: string };
    exchangedRedirects.push(body.redirect_uri);
    if (body.client_secret !== "client-secret") {
      return reply(200, { error: "bad_verification_code" });
    }
    if (body.code === "good-code") {
      return reply(200, { access_token: "ghu_user" });
    }
    return body.code === "fresh-code"
      ? reply(200, { access_token: "ghu_fresh" })
      : reply(200, { error: "bad_verification_code" });
  }
  if (parsed.pathname === "/user/installations") {
    const headers = new Headers(init.headers);
    if (headers.get("authorization") === "Bearer ghu_fresh") {
      return reply(200, { installations: [] });
    }
    return reply(200, {
      installations: [{ id: 77, app_id: 4242, account: { login: "acme" }, updated_at: "2026-09-30T12:00:00Z" }],
    });
  }
  if (/^\/user\/installations\/\d+\/repositories$/.test(parsed.pathname)) {
    return parsed.pathname.includes("/77/")
      ? reply(200, { repositories: [] })
      : reply(404, { message: "Not Found" });
  }
  if (/^\/app\/installations\/\d+$/.test(parsed.pathname)) {
    return parsed.pathname.endsWith("/77")
      ? reply(200, { id: 77, app_id: 4242, account: { login: "acme" }, updated_at: "2026-09-30T12:00:00Z" })
      : reply(404, { message: "Not Found" });
  }
  if (parsed.pathname === "/app/installations/77/access_tokens") {
    return reply(201, { token: "ghs_install", expires_at: "2099-01-01T00:00:00Z" });
  }
  if (parsed.pathname === "/installation/repositories") {
    return reply(200, {
      repositories: [
        { id: 101, name: "shop", full_name: "acme/shop", private: true, default_branch: "trunk", owner: { login: "acme" } },
        { id: 102, name: "site", full_name: "acme/site", private: false, default_branch: "main", owner: { login: "acme" } },
      ],
    });
  }
  return reply(404, { message: "Not Found" });
}

test("guild repositories, the GitHub connection, and its repository picker", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  setInstanceKeys(storeKeys({ "github-app": APP_KEYS }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) =>
    github(String(url), init)) as typeof fetch;
  const databaseUrl = await createIsolatedDatabase(dbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-repositories-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool);
  await connectModelProvider(repo, "org_home", "openrouter");
  const app = await buildApp(database, {
    repo,
    notes,
    scripts: new Scripts(repo),
    schedules: new Schedules(repo),
    masterKey: Buffer.from(HEX_MASTER_KEY, "hex"),
  });
  try {
    const guild = await app.inject({ method: "POST", url: "/api/guilds", headers: JSON_HEADERS, payload: { name: "coders" } });
    assert.equal(guild.statusCode, 201);
    const guildId = String(guild.json().id);
    assert.equal(guild.json().git_author_email, "");
    const email = await app.inject({
      method: "PUT",
      url: `/api/guilds/${guildId}`,
      headers: JSON_HEADERS,
      payload: { git_author_email: "dev@example.com" },
    });
    assert.equal(email.statusCode, 200, email.body);
    assert.equal(email.json().git_author_email, "dev@example.com");
    const invalid = await app.inject({
      method: "PUT",
      url: `/api/guilds/${guildId}`,
      headers: JSON_HEADERS,
      payload: { git_author_email: "a_1@agents.guilds.invalid" },
    });
    assert.equal(invalid.statusCode, 422);
    const omitted = await app.inject({
      method: "PUT",
      url: `/api/guilds/${guildId}`,
      headers: JSON_HEADERS,
      payload: { about: "coders" },
    });
    assert.equal(omitted.json().git_author_email, "dev@example.com");
    const cleared = await app.inject({
      method: "PUT",
      url: `/api/guilds/${guildId}`,
      headers: JSON_HEADERS,
      payload: { git_author_email: "" },
    });
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.json().git_author_email, "");
    const base = `/api/guilds/${guildId}/repositories`;

    assert.deepEqual((await app.inject({ method: "GET", url: base, headers: OWNER })).json(), {
      repositories: [],
      github_connections: [],
    });
    const plain = await app.inject({
      method: "POST",
      url: base,
      headers: JSON_HEADERS,
      payload: { name: "docs", url: "https://git.example.com/docs.git" },
    });
    assert.equal(plain.statusCode, 201, plain.body);
    assert.equal(plain.json().default_branch, "main");
    assert.equal(plain.json().connection, null);
    const twice = await app.inject({
      method: "POST",
      url: base,
      headers: JSON_HEADERS,
      payload: { name: "docs", url: "https://git.example.com/other.git" },
    });
    assert.equal(twice.statusCode, 409);
    const badName = await app.inject({ method: "POST", url: base, headers: JSON_HEADERS, payload: { name: "Docs", url: "https://x.dev/a" } });
    assert.equal(badName.statusCode, 422);

    // Connect sends the operator to user authorization; the login waits, with no binding.
    const connectRes = await app.inject({
      method: "POST",
      url: "/api/mcp/connections",
      headers: JSON_HEADERS,
      payload: { mcp_server_id: "mcp_github", owner_scope: "org", owner_id: "org_home" },
    });
    assert.equal(connectRes.statusCode, 201, connectRes.body);
    const authorize = new URL(String(connectRes.json().authorization_url));
    assert.equal(authorize.origin + authorize.pathname, "https://github.com/login/oauth/authorize");
    const state = String(authorize.searchParams.get("state"));
    const connectionId = String(connectRes.json().id);
    assert.equal(connectRes.json().status, "pending");
    assert.deepEqual(await repo.listBindingsForConnection(connectionId), []);

    // An installation id the user cannot reach proves nothing: the attempt is dropped.
    const forged = await app.inject({
      method: "GET",
      url: `/api/mcp/oauth/callback?code=good-code&installation_id=99&setup_action=install&state=${state}`,
    });
    assert.equal(forged.statusCode, 400);
    assert.match(forged.body, /not one the authorizing user can reach/);
    assert.equal(await repo.getMcpConnection(connectionId), null);

    const asked = await app.inject({
      method: "POST",
      url: "/api/mcp/connections",
      headers: JSON_HEADERS,
      payload: { mcp_server_id: "mcp_github", owner_scope: "org", owner_id: "org_home" },
    });
    const askedState = String(new URL(String(asked.json().authorization_url)).searchParams.get("state"));
    const requested = await app.inject({
      method: "GET",
      url: `/api/mcp/oauth/callback?setup_action=request&state=${askedState}`,
    });
    assert.equal(requested.statusCode, 400);
    assert.match(requested.body, /organisation admin needs to approve/);
    assert.equal(await repo.getMcpConnection(String(asked.json().id)), null);

    const retry = await app.inject({
      method: "POST",
      url: "/api/mcp/connections",
      headers: JSON_HEADERS,
      payload: { mcp_server_id: "mcp_github", owner_scope: "org", owner_id: "org_home" },
    });
    const retryState = String(new URL(String(retry.json().authorization_url)).searchParams.get("state"));
    const githubId = String(retry.json().id);
    const setup = await app.inject({
      method: "GET",
      url: `/api/mcp/oauth/callback?installation_id=77&setup_action=install&state=${retryState}`,
    });
    assert.equal(setup.statusCode, 302, setup.body);
    const authorizeUser = new URL(String(setup.headers.location));
    assert.equal(authorizeUser.origin + authorizeUser.pathname, "https://github.com/login/oauth/authorize");
    assert.equal(authorizeUser.searchParams.get("state"), retryState);
    const callback = await app.inject({
      method: "GET",
      url: `/api/mcp/oauth/callback?code=good-code&state=${retryState}`,
    });
    assert.equal(callback.statusCode, 200, callback.body);
    const connected = await repo.getMcpConnection(githubId);
    assert.equal(connected?.status, "connected");
    assert.equal(connected?.account_hint, "acme");
    assert.equal(connected?.oauth_state, null);
    const stored = decryptPayload(connected?.ciphertext as Buffer, connected?.nonce as Buffer);
    assert.deepEqual(stored, { installation_id: 77, account: "acme" });
    assert.equal((await repo.listBindingsForConnection(githubId)).length, 1);

    const picker = await app.inject({
      method: "GET",
      url: `/api/mcp/connections/${githubId}/github/repositories`,
      headers: OWNER,
    });
    assert.equal(picker.statusCode, 200, picker.body);
    assert.deepEqual(
      picker.json().repositories.map((row: { full_name: string; url: string }) => [row.full_name, row.url]),
      [
        ["acme/shop", "https://github.com/acme/shop"],
        ["acme/site", "https://github.com/acme/site"],
      ],
    );

    const unreachable = await app.inject({
      method: "POST",
      url: base,
      headers: JSON_HEADERS,
      payload: { name: "infra", url: "https://github.com/acme/infra", connection_id: githubId },
    });
    assert.equal(unreachable.statusCode, 422);
    assert.equal(unreachable.json().detail, "the GitHub connection does not reach acme/infra");
    const shop = await app.inject({
      method: "POST",
      url: base,
      headers: JSON_HEADERS,
      payload: { name: "shop", url: "https://github.com/acme/shop.git", connection_id: githubId },
    });
    assert.equal(shop.statusCode, 201, shop.body);
    assert.equal(shop.json().default_branch, "trunk");
    assert.deepEqual(shop.json().connection, { id: githubId, status: "connected", account_hint: "acme" });
    const shopRow = (await repo.listGuildRepositories(guildId)).find((row) => row.name === "shop");
    assert.equal(Number(shopRow?.github_id), 101, "GitHub's id is recorded with the repository");
    const afterConnect = await app.inject({ method: "GET", url: base, headers: OWNER });
    assert.deepEqual(
      afterConnect.json().github_connections.map((row: { id: string; account_hint: string }) => [row.id, row.account_hint]),
      [[githubId, "acme"]],
    );

    // Deleting the connection removes the repositories added through it, and leaves the anonymous one.
    assert.equal(
      (await app.inject({ method: "DELETE", url: `/api/mcp/connections/${githubId}`, headers: OWNER })).statusCode,
      204,
    );
    const listed = (await app.inject({ method: "GET", url: base, headers: OWNER })).json().repositories;
    assert.deepEqual(
      listed.map((row: { name: string; connection_id: string | null }) => [row.name, row.connection_id]),
      [["docs", null]],
    );
    const removed = await app.inject({ method: "DELETE", url: `${base}/${String(plain.json().id)}`, headers: OWNER });
    assert.equal(removed.statusCode, 204);
    assert.equal((await app.inject({ method: "DELETE", url: `${base}/${String(plain.json().id)}`, headers: OWNER })).statusCode, 404);

    // After the operator authorizes, GitHub often returns only `code` and drops `state`.
    const hop = await app.inject({
      method: "POST",
      url: "/api/mcp/connections",
      headers: JSON_HEADERS,
      payload: { mcp_server_id: "mcp_github", owner_scope: "org", owner_id: "org_home" },
    });
    assert.equal(hop.statusCode, 201, hop.body);
    const setCookie = hop.headers["set-cookie"];
    const cookieHeader = (Array.isArray(setCookie) ? setCookie : [setCookie])
      .map((value) => String(value).split(";")[0])
      .find((value) => value?.startsWith("guilds_github_oauth="));
    assert.ok(cookieHeader);
    const dropped = await app.inject({
      method: "GET",
      url: "/api/mcp/oauth/callback?code=good-code&setup_action=install",
      headers: { cookie: cookieHeader! },
    });
    assert.equal(dropped.statusCode, 200, dropped.body);
    const hopRow = await repo.getMcpConnection(String(hop.json().id));
    assert.equal(hopRow?.status, "connected");
    assert.deepEqual(decryptPayload(hopRow?.ciphertext as Buffer, hopRow?.nonce as Buffer), {
      installation_id: 77,
      account: "acme",
    });
    assert.equal(
      (await app.inject({ method: "DELETE", url: `/api/mcp/connections/${String(hop.json().id)}`, headers: OWNER })).statusCode,
      204,
    );

    // A user who has not installed the App is sent on to install it. GitHub's own authorization
    // hop then returns a code issued without `redirect_uri`, which is traded without one.
    const fresh = await app.inject({
      method: "POST",
      url: "/api/mcp/connections",
      headers: JSON_HEADERS,
      payload: { mcp_server_id: "mcp_github", owner_scope: "org", owner_id: "org_home" },
    });
    assert.equal(fresh.statusCode, 201, fresh.body);
    const freshState = String(new URL(String(fresh.json().authorization_url)).searchParams.get("state"));
    const toInstall = await app.inject({
      method: "GET",
      url: `/api/mcp/oauth/callback?code=fresh-code&state=${freshState}`,
    });
    assert.equal(toInstall.statusCode, 302, toInstall.body);
    const install = new URL(String(toInstall.headers.location));
    assert.equal(install.origin + install.pathname, "https://github.com/apps/guilds-run-test/installations/new");
    assert.equal(install.searchParams.get("state"), freshState);
    assert.equal((await repo.getMcpConnection(String(fresh.json().id)))?.status, "pending");
    exchangedRedirects.length = 0;
    const installed = await app.inject({
      method: "GET",
      url: `/api/mcp/oauth/callback?code=good-code&installation_id=77&setup_action=install&state=${freshState}`,
    });
    assert.equal(installed.statusCode, 200, installed.body);
    assert.deepEqual(exchangedRedirects, [undefined]);
    assert.equal((await repo.getMcpConnection(String(fresh.json().id)))?.status, "connected");
  } finally {
    globalThis.fetch = realFetch;
    setInstanceKeys({});
    await app.close();
    await database.close();
  }
});

test("a second guild reuses the GitHub App and picks its own repositories", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  setInstanceKeys(storeKeys({ "github-app": APP_KEYS }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) =>
    github(String(url), init)) as typeof fetch;
  const extraDb = uniqueDbName("agent_platform_coding_guilds");
  const databaseUrl = await createIsolatedDatabase(extraDb);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-repositories-guilds-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool);
  await connectModelProvider(repo, "org_home", "openrouter");
  const app = await buildApp(database, {
    repo,
    notes,
    scripts: new Scripts(repo),
    schedules: new Schedules(repo),
    masterKey: Buffer.from(HEX_MASTER_KEY, "hex"),
  });
  try {
    const frontend = await app.inject({
      method: "POST",
      url: "/api/guilds",
      headers: JSON_HEADERS,
      payload: { name: "frontend" },
    });
    const backend = await app.inject({
      method: "POST",
      url: "/api/guilds",
      headers: JSON_HEADERS,
      payload: { name: "backend" },
    });
    assert.equal(frontend.statusCode, 201, frontend.body);
    assert.equal(backend.statusCode, 201, backend.body);
    const frontendId = String(frontend.json().id);
    const backendId = String(backend.json().id);

    const first = await app.inject({
      method: "POST",
      url: "/api/mcp/connections",
      headers: JSON_HEADERS,
      payload: { mcp_server_id: "mcp_github", owner_scope: "guild", owner_id: frontendId },
    });
    assert.equal(first.statusCode, 201, first.body);
    const firstAuthorize = new URL(String(first.json().authorization_url));
    assert.equal(firstAuthorize.origin + firstAuthorize.pathname, "https://github.com/login/oauth/authorize");
    const firstState = String(firstAuthorize.searchParams.get("state"));
    const firstId = String(first.json().id);
    const setup = await app.inject({
      method: "GET",
      url: `/api/mcp/oauth/callback?installation_id=77&setup_action=install&state=${firstState}`,
    });
    assert.equal(setup.statusCode, 302, setup.body);
    const callback = await app.inject({
      method: "GET",
      url: `/api/mcp/oauth/callback?code=good-code&state=${firstState}`,
    });
    assert.equal(callback.statusCode, 200, callback.body);
    assert.equal((await repo.getMcpConnection(firstId))?.status, "connected");

    const backendListed = await app.inject({
      method: "GET",
      url: `/api/guilds/${backendId}/repositories`,
      headers: OWNER,
    });
    assert.equal(backendListed.statusCode, 200, backendListed.body);
    assert.deepEqual(
      backendListed.json().github_connections.map((row: { id: string; owner_scope: string }) => [row.id, row.owner_scope]),
      [[firstId, "guild"]],
    );
    const site = await app.inject({
      method: "POST",
      url: `/api/guilds/${backendId}/repositories`,
      headers: JSON_HEADERS,
      payload: { name: "site", url: "https://github.com/acme/site", connection_id: firstId },
    });
    assert.equal(site.statusCode, 201, site.body);
    assert.deepEqual(site.json().connection, { id: firstId, status: "connected", account_hint: "acme" });
    const shop = await app.inject({
      method: "POST",
      url: `/api/guilds/${frontendId}/repositories`,
      headers: JSON_HEADERS,
      payload: { name: "shop", url: "https://github.com/acme/shop", connection_id: firstId },
    });
    assert.equal(shop.statusCode, 201, shop.body);

    const retry = await app.inject({
      method: "POST",
      url: "/api/mcp/connections",
      headers: JSON_HEADERS,
      payload: { mcp_server_id: "mcp_github", owner_scope: "guild", owner_id: backendId },
    });
    assert.equal(retry.statusCode, 201, retry.body);
    const retryAuthorize = new URL(String(retry.json().authorization_url));
    assert.equal(retryAuthorize.origin + retryAuthorize.pathname, "https://github.com/login/oauth/authorize");
    const retryState = String(retryAuthorize.searchParams.get("state"));
    const retryId = String(retry.json().id);
    const reused = await app.inject({
      method: "GET",
      url: `/api/mcp/oauth/callback?code=good-code&state=${retryState}`,
    });
    assert.equal(reused.statusCode, 200, reused.body);
    const backendConn = await repo.getMcpConnection(retryId);
    assert.equal(backendConn?.status, "connected");
    assert.equal(backendConn?.account_hint, "acme");
    assert.deepEqual(decryptPayload(backendConn?.ciphertext as Buffer, backendConn?.nonce as Buffer), {
      installation_id: 77,
      account: "acme",
    });

    const picked = await app.inject({
      method: "PUT",
      url: `/api/mcp/connections/${retryId}/github/selected`,
      headers: JSON_HEADERS,
      payload: { repositories: [{ name: "site", url: "https://github.com/acme/site" }] },
    });
    assert.equal(picked.statusCode, 200, picked.body);
    assert.deepEqual(picked.json().repositories, [
      { name: "site", url: "https://github.com/acme/site", default_branch: "main", github_id: 102 },
    ]);
    const guildAccess = await app.inject({
      method: "GET",
      url: `/api/guilds/${backendId}/access`,
      headers: OWNER,
    });
    const github = (guildAccess.json().mcp as Array<{ slug: string; settings: { repositories?: unknown } }>).find(
      (item) => item.slug === "github",
    );
    assert.deepEqual(github?.settings.repositories, [
      { name: "site", url: "https://github.com/acme/site", default_branch: "main", github_id: 102 },
    ]);

    await codeDefaultMachine(app, OWNER);
    const agent = await app.inject({
      method: "POST",
      url: `/api/guilds/${backendId}/agents`,
      headers: JSON_HEADERS,
      payload: { name: "coder", config: { model: "openrouter/openai/gpt-5.6-luna", browser: false, coding: true, harness: "claude-code" } },
    });
    assert.equal(agent.statusCode, 201, agent.body);
    const agentConnect = await app.inject({
      method: "POST",
      url: "/api/mcp/connections",
      headers: JSON_HEADERS,
      payload: { mcp_server_id: "mcp_github", owner_scope: "agent", owner_id: String(agent.json().id) },
    });
    assert.equal(agentConnect.statusCode, 201, agentConnect.body);
    const agentAuthorize = new URL(String(agentConnect.json().authorization_url));
    assert.equal(agentAuthorize.origin + agentAuthorize.pathname, "https://github.com/login/oauth/authorize");
    const agentState = String(agentAuthorize.searchParams.get("state"));
    const agentCallback = await app.inject({
      method: "GET",
      url: `/api/mcp/oauth/callback?code=good-code&state=${agentState}`,
    });
    assert.equal(agentCallback.statusCode, 200, agentCallback.body);
    const agentPicked = await app.inject({
      method: "PUT",
      url: `/api/mcp/connections/${String(agentConnect.json().id)}/github/selected`,
      headers: JSON_HEADERS,
      payload: { repositories: [{ name: "shop", url: "https://github.com/acme/shop" }] },
    });
    assert.equal(agentPicked.statusCode, 200, agentPicked.body);
    assert.equal(agentPicked.json().repositories[0]?.default_branch, "trunk");
  } finally {
    globalThis.fetch = realFetch;
    setInstanceKeys({});
    await app.close();
    await database.close();
    await dropIsolatedDatabase(extraDb);
  }
});

test("several GitHub installations open a picker so a guild can choose the account", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  setInstanceKeys(storeKeys({ "github-app": APP_KEYS }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/user/installations") {
      return new Response(
        JSON.stringify({
          installations: [
            { id: 77, app_id: 4242, account: { login: "acme" }, updated_at: "2026-09-30T12:00:00Z" },
            { id: 88, app_id: 4242, account: { login: "widgets" }, updated_at: "2026-01-01T00:00:00Z" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return github(String(url), init);
  }) as typeof fetch;
  const extraDb = uniqueDbName("agent_platform_coding_picker");
  const databaseUrl = await createIsolatedDatabase(extraDb);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-repositories-picker-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool);
  await connectModelProvider(repo, "org_home", "openrouter");
  const app = await buildApp(database, {
    repo,
    notes,
    scripts: new Scripts(repo),
    schedules: new Schedules(repo),
    masterKey: Buffer.from(HEX_MASTER_KEY, "hex"),
  });
  try {
    const guild = await app.inject({
      method: "POST",
      url: "/api/guilds",
      headers: JSON_HEADERS,
      payload: { name: "pickers" },
    });
    const connectRes = await app.inject({
      method: "POST",
      url: "/api/mcp/connections",
      headers: JSON_HEADERS,
      payload: { mcp_server_id: "mcp_github", owner_scope: "org", owner_id: "org_home" },
    });
    const state = String(new URL(String(connectRes.json().authorization_url)).searchParams.get("state"));
    const connectionId = String(connectRes.json().id);
    const setup = await app.inject({
      method: "GET",
      url: `/api/mcp/oauth/callback?code=good-code&state=${state}`,
    });
    assert.equal(setup.statusCode, 302, setup.body);
    const location = String(setup.headers.location);
    assert.match(location, /\/api\/mcp\/oauth\/github-installation\?state=/);
    const pickerState = new URL(location, "http://127.0.0.1").searchParams.get("state");
    const page = await app.inject({ method: "GET", url: location });
    assert.equal(page.statusCode, 200, page.body);
    assert.match(page.body, /Pick a GitHub account/);
    const listed = await app.inject({
      method: "GET",
      url: `/api/mcp/oauth/github-installations?state=${pickerState}`,
    });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(
      listed.json().installations.map((row: { id: number; account: string }) => [row.id, row.account]),
      [
        [77, "acme"],
        [88, "widgets"],
      ],
    );
    const picked = await app.inject({
      method: "POST",
      url: "/api/mcp/oauth/github-installation",
      headers: { "content-type": "application/json" },
      payload: { state: pickerState, installation_id: 88 },
    });
    assert.equal(picked.statusCode, 200, picked.body);
    const connected = await repo.getMcpConnection(connectionId);
    assert.equal(connected?.status, "connected");
    assert.equal(connected?.account_hint, "widgets");
    assert.equal(guild.statusCode, 201);
  } finally {
    globalThis.fetch = realFetch;
    setInstanceKeys({});
    await app.close();
    await database.close();
    await dropIsolatedDatabase(extraDb);
  }
});
