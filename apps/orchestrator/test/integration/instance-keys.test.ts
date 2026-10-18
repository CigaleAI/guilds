import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import { connect } from "../../src/db/client.js";
import { Repositories } from "../../src/db/repositories.js";
import { GITHUB_SERVER_ID } from "../../src/github/index.js";
import { GITHUB_MANIFEST_STATE_COOKIE, MANIFEST_CALLBACK_PATH } from "../../src/github/manifest.js";
import { setInstanceKeys } from "../../src/instance/integrations.js";
import { NotesStore } from "../../src/notes/store.js";
import { Scripts } from "../../src/scripts/catalog.js";
import { Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const OWNER = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const JSON_HEADERS = { ...OWNER, "content-type": "application/json" };
const MASTER = Buffer.from(HEX_MASTER_KEY, "hex");
const TAVILY_SERVER_ID = "mcp_tavily";
const ADMIN_PAGE = "/admin?tab=instance&integration=github-app";
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const APP = { app_id: "4242", slug: "guilds-run-test", private_key: PEM, client_id: "Iv1.client", client_secret: "client-secret" };

const keysDb = uniqueDbName("agent_platform_instance_keys");
const manifestDb = uniqueDbName("agent_platform_instance_manifest");

after(async () => {
  await dropIsolatedDatabase(keysDb);
  await dropIsolatedDatabase(manifestDb);
});

type App = Awaited<ReturnType<typeof buildApp>>;
type Status = { id: string; state: string; set_by: string | null; updated_at: string | null };

async function bootstrap(dbName: string, prefix: string): Promise<{ database: Awaited<ReturnType<typeof connect>>; repo: Repositories; app: App }> {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  setInstanceKeys({});
  const database = await connect(await createIsolatedDatabase(dbName));
  const notes = new NotesStore(tempDir(prefix), templatesRoot());
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool);
  const app = await buildApp(database, {
    repo,
    notes,
    scripts: new Scripts(repo),
    schedules: new Schedules(repo),
    masterKey: MASTER,
  });
  return { database, repo, app };
}

async function status(app: App, id: string): Promise<Status> {
  const response = await app.inject({ method: "GET", url: "/api/instance", headers: OWNER });
  assert.equal(response.statusCode, 200, response.body);
  const found = (response.json().integrations as Status[]).find((item) => item.id === id);
  assert.ok(found, id);
  return found;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function setCookies(headers: Record<string, unknown>): string[] {
  const raw = headers["set-cookie"];
  return Array.isArray(raw) ? raw.map(String) : raw === undefined ? [] : [String(raw)];
}

test("instance keys switch platform logins and the GitHub connector; replacing the App is confirmed with its logins", { timeout: 60_000 }, async () => {
  const { database, repo, app } = await bootstrap(keysDb, "guilds-instance-keys-");
  const put = (integration: string, payload: Record<string, unknown>) =>
    app.inject({ method: "PUT", url: `/api/admin/instance/keys/${integration}`, headers: JSON_HEADERS, payload });
  const remove = (integration: string, query = "") =>
    app.inject({ method: "DELETE", url: `/api/admin/instance/keys/${integration}${query}`, headers: OWNER });
  const platformLogin = () => repo.getMcpConnectionForOwner(TAVILY_SERVER_ID, "platform", null);
  const connectGithub = () =>
    app.inject({
      method: "POST",
      url: "/api/mcp/connections",
      headers: JSON_HEADERS,
      payload: { mcp_server_id: GITHUB_SERVER_ID, owner_scope: "org", owner_id: "org_home" },
    });
  /** A GitHub login installed with the current App, at the organisation. */
  const seedConnectedGithub = async (): Promise<string> => {
    const [ciphertext, nonce] = encryptPayload({ installation_id: 77, account: "acme" }, MASTER);
    const row = await repo.connectMcp("conn_github_seed", "bind_github_seed", GITHUB_SERVER_ID, "org", "org_home", ciphertext, nonce, new Date(), {
      status: "connected",
      accountHint: "acme",
    });
    return String(row.id);
  };
  const connectionStatus = async (id: string) => String((await repo.getMcpConnection(id))?.status);
  try {
    // Web search: the Tavily platform login follows the key.
    assert.equal(await platformLogin(), null);
    assert.equal((await status(app, "web-search")).state, "off");
    const stored = await put("web-search", { values: { api_key: "tvly-platform" } });
    assert.equal(stored.statusCode, 200, stored.body);
    assert.equal(stored.json().integration.state, "on");
    assert.equal(stored.json().integration.id, "web-search");
    assert.equal(stored.json().disconnected, 0);
    assert.equal(stored.body.includes("tvly-platform"), false, "the value never comes back");
    assert.equal((await platformLogin())?.status, "connected");
    assert.equal((await platformLogin())?.owner_scope, "platform");
    const removed = await remove("web-search");
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(removed.json().integration.state, "off");
    assert.equal(removed.json().disconnected, 0);
    assert.equal((await platformLogin())?.status, "disconnected");

    // Writes the store refuses.
    const unknownField = await put("web-search", { values: { api_key: "k", token: "x" } });
    assert.equal(unknownField.statusCode, 400, unknownField.body);
    assert.match(String(unknownField.json().detail), /has no field token/);
    assert.equal((await put("web-search", { values: {} })).statusCode, 400);
    assert.equal((await put("web-search", { values: { api_key: 7 } })).statusCode, 400);
    const env = await put("registry", { values: { REGISTRY_URL: "https://r.example" } });
    assert.equal(env.statusCode, 400, env.body);
    assert.match(String(env.json().detail), /read from the environment/);
    assert.equal((await remove("registry")).statusCode, 400);
    assert.equal((await put("nope", { values: {} })).statusCode, 404);
    assert.equal((await remove("nope")).statusCode, 404);
    assert.equal((await status(app, "web-search")).state, "off", "a refused write changes nothing");

    // GitHub App: the connector connects only once the App is stored.
    const unconfigured = await connectGithub();
    assert.equal(unconfigured.statusCode, 422, unconfigured.body);
    assert.equal(unconfigured.json().detail.setup_state, "unsupported");
    const appStored = await put("github-app", { values: APP });
    assert.equal(appStored.statusCode, 200, appStored.body);
    assert.equal(appStored.json().integration.state, "on");
    assert.equal(appStored.json().integration.setup, "github-app-manifest");
    assert.equal(appStored.body.includes("client-secret"), false);
    assert.equal(appStored.body.includes("PRIVATE KEY"), false);
    const configured = await connectGithub();
    assert.equal(configured.statusCode, 201, configured.body);
    assert.ok(String(configured.json().authorization_url).startsWith("https://github.com/login/oauth/authorize?client_id=Iv1.client&"));

    // Replacing the App strands the logins installed with it: the admin confirms, with the count.
    const seeded = await seedConnectedGithub();
    assert.equal(await connectionStatus(seeded), "connected");
    const rotated = await put("github-app", { values: { ...APP, client_secret: "rotated" } });
    assert.equal(rotated.statusCode, 200, rotated.body);
    assert.equal(rotated.json().disconnected, 0, "rotating a secret of the same App needs no confirmation");
    assert.equal(await connectionStatus(seeded), "connected");
    const other = await put("github-app", { values: { ...APP, app_id: "9999" } });
    assert.equal(other.statusCode, 409, other.body);
    assert.deepEqual(other.json().detail, {
      message: "Replacing the GitHub App disconnects 1 GitHub login.",
      replaces_app: true,
      connections: 1,
    });
    assert.equal(await connectionStatus(seeded), "connected");
    const confirmed = await put("github-app", { values: { ...APP, app_id: "9999" }, confirm_replace: true });
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    assert.equal(confirmed.json().disconnected, 1);
    assert.equal(await connectionStatus(seeded), "disconnected");
    assert.equal((await status(app, "github-app")).state, "on");

    // Removing the App does the same.
    const reseeded = await seedConnectedGithub();
    const unconfirmed = await remove("github-app");
    assert.equal(unconfirmed.statusCode, 409, unconfirmed.body);
    assert.equal(unconfirmed.json().detail.replaces_app, true);
    assert.equal(unconfirmed.json().detail.connections, 1);
    assert.equal(await connectionStatus(reseeded), "connected");
    const gone = await remove("github-app", "?confirm_replace=1");
    assert.equal(gone.statusCode, 200, gone.body);
    assert.equal(gone.json().disconnected, 1);
    assert.equal(gone.json().integration.state, "off");
    assert.equal(await connectionStatus(reseeded), "disconnected");
    assert.equal((await connectGithub()).statusCode, 422);
  } finally {
    setInstanceKeys({});
    await app.close();
    await database.close();
  }
});

test("the GitHub App registers from a manifest: the box posts it, GitHub calls back, the code becomes the App", { timeout: 60_000 }, async () => {
  const { database, app } = await bootstrap(manifestDb, "guilds-instance-manifest-");
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  let conversion: () => Response = () => json(500, { message: "not stubbed" });
  globalThis.fetch = (async (url: string | URL | Request) => {
    asked.push(String(url));
    return conversion();
  }) as typeof fetch;
  const start = (payload: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: "/api/admin/instance/keys/github-app/manifest",
      headers: { ...JSON_HEADERS, host: "127.0.0.1:8080" },
      payload,
    });
  const callback = (query: Record<string, string>, cookie: string) =>
    app.inject({
      method: "GET",
      url: `${MANIFEST_CALLBACK_PATH}?${new URLSearchParams(query).toString()}`,
      headers: cookie ? { cookie } : {},
    });
  const stateCookie = (state: string) => `${GITHUB_MANIFEST_STATE_COOKIE}=${encodeURIComponent(state)}`;
  const converted = () =>
    json(201, {
      id: 4242,
      slug: "guilds-box",
      pem: PEM,
      client_id: "Iv1.client",
      client_secret: "client-secret",
      html_url: "https://github.com/apps/guilds-box",
    });
  try {
    const started = await start({ name: "Guilds test box", owner: "acme-org", return_to: `${ADMIN_PAGE}&from=test` });
    assert.equal(started.statusCode, 200, started.body);
    const { action, manifest, state } = started.json() as { action: string; manifest: Record<string, unknown>; state: string };
    assert.ok(state.length >= 32, state);
    assert.equal(action, `https://github.com/organizations/acme-org/settings/apps/new?state=${encodeURIComponent(state)}`);
    const cookies = setCookies(started.headers);
    assert.ok(
      cookies.some((cookie) => cookie.startsWith(`${stateCookie(state)}; Path=${MANIFEST_CALLBACK_PATH}; HttpOnly`)),
      cookies.join(" | "),
    );
    assert.equal(manifest.name, "Guilds test box");
    assert.equal(manifest.url, "http://127.0.0.1:8080");
    assert.equal(manifest.redirect_url, `http://127.0.0.1:8080${MANIFEST_CALLBACK_PATH}`);
    assert.deepEqual(manifest.callback_urls, ["http://127.0.0.1:8080/api/mcp/oauth/callback"]);
    assert.equal(manifest.hook_attributes, undefined);
    assert.equal(started.body.includes("client-secret"), false);

    // The default name carries the host; the default action is the admin's own account.
    const unnamed = await start();
    assert.equal(unnamed.statusCode, 200, unnamed.body);
    assert.equal(unnamed.json().manifest.name, "Guilds (127.0.0.1:8080)");
    assert.equal(unnamed.json().action, `https://github.com/settings/apps/new?state=${encodeURIComponent(unnamed.json().state)}`);
    assert.notEqual(unnamed.json().state, state, "every start has its own state");
    assert.equal((await start({ name: "x".repeat(35) })).statusCode, 400);
    assert.equal((await start({ name: "x".repeat(34) })).statusCode, 200);
    assert.equal((await start({ owner: "not a login" })).statusCode, 400);
    assert.equal((await start({ owner: "acme/org" })).statusCode, 400);

    // A callback whose cookie does not match its state is refused before GitHub is asked; the flow is spent.
    conversion = converted;
    const mismatched = await callback({ code: "abc", state }, `${GITHUB_MANIFEST_STATE_COOKIE}=other`);
    assert.equal(mismatched.statusCode, 302, mismatched.body);
    assert.equal(mismatched.headers.location, `${ADMIN_PAGE}&setup_error=state`);
    assert.deepEqual(asked, []);
    const replayed = await callback({ code: "abc", state }, stateCookie(state));
    assert.equal(replayed.statusCode, 302);
    assert.equal(replayed.headers.location, `${ADMIN_PAGE}&setup_error=state`);
    const unknown = await callback({ code: "abc", state: "never-started" }, stateCookie("never-started"));
    assert.equal(unknown.headers.location, `${ADMIN_PAGE}&setup_error=state`);
    const uncookied = await callback({ code: "abc", state: unnamed.json().state }, "");
    assert.equal(uncookied.headers.location, `${ADMIN_PAGE}&setup_error=state`);
    assert.deepEqual(asked, []);
    assert.equal((await status(app, "github-app")).state, "off");

    // GitHub refusing the code.
    const refusedState = (await start()).json().state as string;
    conversion = () => json(422, { message: "Validation Failed" });
    const refused = await callback({ code: "bad", state: refusedState }, stateCookie(refusedState));
    assert.equal(refused.statusCode, 302, refused.body);
    assert.equal(refused.headers.location, `${ADMIN_PAGE}&setup_error=conversion`);
    assert.deepEqual(asked, ["https://api.github.com/app-manifests/bad/conversions"]);
    assert.ok(setCookies(refused.headers).some((cookie) => cookie.startsWith(`${GITHUB_MANIFEST_STATE_COOKIE}=;`) && cookie.includes("Max-Age=0")));
    assert.equal((await status(app, "github-app")).state, "off");

    // The App is stored for the admin who started the flow, and the browser goes back where it asked.
    asked.length = 0;
    const okState = (await start({ return_to: `${ADMIN_PAGE}&from=test` })).json().state as string;
    conversion = converted;
    const done = await callback({ code: "good", state: okState }, stateCookie(okState));
    assert.equal(done.statusCode, 302, done.body);
    assert.equal(done.headers.location, `${ADMIN_PAGE}&from=test`);
    assert.deepEqual(asked, ["https://api.github.com/app-manifests/good/conversions"]);
    assert.ok(
      setCookies(done.headers).some(
        (cookie) => cookie.startsWith(`${GITHUB_MANIFEST_STATE_COOKIE}=; Path=${MANIFEST_CALLBACK_PATH}`) && cookie.includes("Max-Age=0"),
      ),
    );
    const github = await status(app, "github-app");
    assert.equal(github.state, "on");
    assert.ok(github.set_by, "stored for the admin who started the flow");
    assert.match(String(github.updated_at), /^\d{4}-\d{2}-\d{2}T/);
    const connected = await app.inject({
      method: "POST",
      url: "/api/mcp/connections",
      headers: JSON_HEADERS,
      payload: { mcp_server_id: GITHUB_SERVER_ID, owner_scope: "org", owner_id: "org_home" },
    });
    assert.equal(connected.statusCode, 201, connected.body);
    assert.ok(String(connected.json().authorization_url).startsWith("https://github.com/login/oauth/authorize?client_id=Iv1.client&"));

    // A return_to on another origin, or none, lands on the admin page.
    const foreignState = (await start({ return_to: "https://evil.example/x" })).json().state as string;
    const home = await callback({ code: "good2", state: foreignState }, stateCookie(foreignState));
    assert.equal(home.statusCode, 302, home.body);
    assert.equal(home.headers.location, ADMIN_PAGE);
    const protocolRelative = (await start({ return_to: "//evil.example/x" })).json().state as string;
    assert.equal((await callback({ code: "good3", state: protocolRelative }, stateCookie(protocolRelative))).headers.location, ADMIN_PAGE);
  } finally {
    globalThis.fetch = realFetch;
    setInstanceKeys({});
    await app.close();
    await database.close();
  }
});
