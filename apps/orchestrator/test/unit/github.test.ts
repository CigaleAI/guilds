import assert from "node:assert/strict";
import type { McpConnectionRow } from "../../src/db/mcp.js";
import type { GithubRepositorySelection } from "../../src/db/schema/index.js";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { RepositoryTokens } from "../../src/coding/git.js";
import { mintLoginToken, RepositoryAccessError, TOKEN_REFRESH_MS } from "../../src/github/tokens.js";
import {
  codingRepositories,
  validateGithubRepositories,
  validateRepositoryInput,
} from "../../src/coding/repositories.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import {
  appJwt,
  exchangeUserCode,
  githubAppConfig,
  GithubError,
  GithubInstallationGoneError,
  installationForUser,
  installationToken,
  installUrl,
  parseGithubUrl,
  requireGithubApp,
  resolveGithubInstallation,
  userAuthorizationUrl,
  userInstallations,
  type GithubAppConfig,
} from "../../src/github/index.js";
import {
  clearGithubManifestStateCookie,
  convertManifestCode,
  GITHUB_MANIFEST_STATE_COOKIE,
  githubAppManifest,
  githubManifestStateCookie,
  MANIFEST_CALLBACK_PATH,
  manifestAction,
} from "../../src/github/manifest.js";
import { HEX_MASTER_KEY, storeKeys } from "../helpers/env.js";
import { connectionRow } from "../helpers/servers.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const APP: GithubAppConfig = {
  appId: "4242",
  slug: "guilds-run-test",
  privateKey: PEM,
  clientId: "Iv1.client",
  clientSecret: "client-secret",
};
const MASTER = Buffer.from(HEX_MASTER_KEY, "hex");

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (url: string, init: RequestInit) => Response): { fetch: (url: string, init?: RequestInit) => Promise<Response>; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      return respond(url, init);
    },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("the App needs all five values from the instance keys; a pasted key's \\n sequences become newlines", () => {
  const values = {
    app_id: "1",
    slug: "app",
    private_key: "-----BEGIN KEY-----\\nabc\\n-----END KEY-----",
    client_id: "cid",
    client_secret: "secret",
  };
  assert.deepEqual(githubAppConfig({ keys: storeKeys({ "github-app": values }) }), {
    appId: "1",
    slug: "app",
    privateKey: "-----BEGIN KEY-----\nabc\n-----END KEY-----",
    clientId: "cid",
    clientSecret: "secret",
  });
  assert.equal(githubAppConfig({ keys: storeKeys({ "github-app": { ...values, client_secret: " " } }) }), null);
  assert.equal(githubAppConfig({ keys: {} }), null);
  assert.equal(
    githubAppConfig({ env: { GITHUB_APP_ID: "1", GITHUB_APP_SLUG: "app", GITHUB_APP_PRIVATE_KEY: "k", GITHUB_APP_CLIENT_ID: "c", GITHUB_APP_CLIENT_SECRET: "s" }, keys: {} }),
    null,
    "the environment no longer serves the App",
  );
  assert.throws(
    () => requireGithubApp({ keys: storeKeys({ "github-app": { app_id: "1" } }) }),
    (error: unknown) =>
      error instanceof GithubError && /App slug, Private key \(PEM\), Client ID, Client secret missing/.test(error.message),
  );
});

test("the manifest registers the App on the box's address, adding the request's own callback when it differs", () => {
  const manifest = githubAppManifest({ baseUrl: "https://guilds.example/", requestOrigin: "http://127.0.0.1:8080" });
  assert.equal(manifest.name, "Guilds (guilds.example)");
  assert.equal(manifest.url, "https://guilds.example");
  assert.equal(manifest.redirect_url, `https://guilds.example${MANIFEST_CALLBACK_PATH}`);
  assert.deepEqual(manifest.callback_urls, [
    "https://guilds.example/api/mcp/oauth/callback",
    "http://127.0.0.1:8080/api/mcp/oauth/callback",
  ]);
  assert.deepEqual(manifest.hook_attributes, { url: "https://guilds.example/api/github/webhook", active: false });
  assert.equal(githubAppManifest({ baseUrl: "http://localhost:8080", requestOrigin: "http://localhost:8080" }).hook_attributes, undefined);
  assert.equal(githubAppManifest({ baseUrl: "http://127.0.0.1:8080", requestOrigin: "http://127.0.0.1:8080" }).hook_attributes, undefined);
  assert.equal(githubAppManifest({ baseUrl: "http://192.168.1.10:8080", requestOrigin: "http://192.168.1.10:8080" }).hook_attributes, undefined);
  assert.deepEqual(manifest.default_permissions, {
    contents: "write",
    pull_requests: "write",
    issues: "write",
    actions: "read",
    checks: "read",
    statuses: "read",
    metadata: "read",
  });
  assert.equal(manifest.public, false);
  assert.equal(manifest.request_oauth_on_install, true);
  assert.equal(manifest.setup_on_update, true);
  const same = githubAppManifest({ baseUrl: "https://guilds.example", requestOrigin: "https://guilds.example/", name: " Team box " });
  assert.deepEqual(same.callback_urls, ["https://guilds.example/api/mcp/oauth/callback"]);
  assert.equal(same.name, "Team box");
  assert.equal(githubAppManifest({ baseUrl: "https://guilds.example", requestOrigin: "https://guilds.example", name: "  " }).name, "Guilds (guilds.example)");
});

test("the manifest is posted to the admin's account or to an organisation, carrying the state", () => {
  assert.equal(manifestAction(null, "s t"), "https://github.com/settings/apps/new?state=s%20t");
  assert.equal(manifestAction("acme-org", "abc"), "https://github.com/organizations/acme-org/settings/apps/new?state=abc");
});

test("the manifest state cookie is bound to the callback path and short-lived; clearing it expires it", () => {
  assert.equal(GITHUB_MANIFEST_STATE_COOKIE, "guilds_github_manifest");
  assert.equal(
    githubManifestStateCookie("s t", false),
    `guilds_github_manifest=s%20t; Path=${MANIFEST_CALLBACK_PATH}; HttpOnly; SameSite=Lax; Max-Age=1200`,
  );
  assert.equal(
    githubManifestStateCookie("abc", true),
    `guilds_github_manifest=abc; Path=${MANIFEST_CALLBACK_PATH}; HttpOnly; SameSite=Lax; Max-Age=1200; Secure`,
  );
  assert.equal(
    clearGithubManifestStateCookie(false),
    `guilds_github_manifest=; Path=${MANIFEST_CALLBACK_PATH}; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
  assert.equal(
    clearGithubManifestStateCookie(true),
    `guilds_github_manifest=; Path=${MANIFEST_CALLBACK_PATH}; HttpOnly; SameSite=Lax; Max-Age=0; Secure`,
  );
});

test("a manifest code converts into the App's fields; GitHub refusing it or omitting the key is an error", async () => {
  const fake = fakeFetch(() =>
    json(201, {
      id: 4242,
      slug: "guilds-box",
      pem: PEM,
      client_id: "Iv1.client",
      client_secret: "client-secret",
      html_url: "https://github.com/apps/guilds-box",
    }),
  );
  const converted = await convertManifestCode("code 1", { fetch: fake.fetch });
  assert.deepEqual(converted, {
    app_id: "4242",
    slug: "guilds-box",
    private_key: PEM,
    client_id: "Iv1.client",
    client_secret: "client-secret",
    html_url: "https://github.com/apps/guilds-box",
  });
  assert.equal(fake.calls[0]?.url, "https://api.github.com/app-manifests/code%201/conversions");
  assert.equal(fake.calls[0]?.init.method, "POST");
  assert.equal((fake.calls[0]?.init.headers as Record<string, string>).Authorization, undefined, "the conversion needs no token");
  const refused = fakeFetch(() => json(422, { message: "Validation Failed" }));
  await assert.rejects(
    convertManifestCode("bad", { fetch: refused.fetch }),
    (error: unknown) => error instanceof GithubError && error.status === 422 && /422 Validation Failed/.test(error.message),
  );
  const keyless = fakeFetch(() => json(201, { id: 4242, slug: "s", client_id: "c", client_secret: "x" }));
  await assert.rejects(
    convertManifestCode("c", { fetch: keyless.fetch }),
    (error: unknown) => error instanceof GithubError && error.status === null && /returned no pem/.test(error.message),
  );
});

test("the App token is an RS256 JWT issued by the App, valid under ten minutes", () => {
  const now = new Date("2026-09-30T12:00:00Z");
  const token = appJwt(APP, now);
  const [header, payload, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as Record<string, number | string>;
  assert.equal(claims.iss, "4242");
  assert.equal(Number(claims.exp) - Number(claims.iat), 540);
  assert.equal(claims.iat, Math.floor(now.getTime() / 1000) - 60);
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  assert.ok(verifier.verify(publicKey, Buffer.from(signature!, "base64url")));
});

test("the App's install page carries the state", () => {
  assert.equal(installUrl(APP, "s t"), "https://github.com/apps/guilds-run-test/installations/new?state=s%20t");
});

test("user authorization after a setup redirect keeps state and the callback URL", () => {
  assert.equal(
    userAuthorizationUrl(APP, "s t", "https://guilds.run/api/mcp/oauth/callback"),
    "https://github.com/login/oauth/authorize?client_id=Iv1.client&redirect_uri=https%3A%2F%2Fguilds.run%2Fapi%2Fmcp%2Foauth%2Fcallback&state=s+t",
  );
});

test("only https://github.com/<owner>/<repository> is a GitHub repository URL", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/acme/shop.git"), { owner: "acme", repository: "shop" });
  assert.deepEqual(parseGithubUrl("https://github.com/acme/shop/"), { owner: "acme", repository: "shop" });
  assert.equal(parseGithubUrl("https://github.com/acme"), null);
  assert.equal(parseGithubUrl("http://github.com/acme/shop"), null);
  assert.equal(parseGithubUrl("https://gitlab.com/acme/shop"), null);
});

test("an installation token is scoped to repository ids, holds the permissions asked for, and names them as they are now", async () => {
  const fake = fakeFetch(() =>
    json(201, {
      token: "ghs_abc",
      expires_at: "2026-09-30T13:00:00Z",
      repositories: [{ id: 101, full_name: "acme/shop", name: "shop" }, { full_name: "acme/no-id" }],
    }),
  );
  const minted = await installationToken(APP, 77, { repositoryIds: [101], fetch: fake.fetch });
  assert.deepEqual(minted, {
    token: "ghs_abc",
    expiresAt: "2026-09-30T13:00:00Z",
    repositories: [{ id: 101, full_name: "acme/shop" }],
  });
  assert.equal(fake.calls[0]?.url, "https://api.github.com/app/installations/77/access_tokens");
  assert.deepEqual(JSON.parse(String(fake.calls[0]?.init.body)), { repository_ids: [101] }, "every permission the installation grants");
  assert.match(String((fake.calls[0]?.init.headers as Record<string, string>).Authorization), /^Bearer ey/);
  await installationToken(APP, 77, { repositoryIds: [101], permissions: { issues: "read" }, fetch: fake.fetch });
  assert.deepEqual(JSON.parse(String(fake.calls[1]?.init.body)), { repository_ids: [101], permissions: { issues: "read" } });
  const gone = fakeFetch(() => json(404, { message: "Not Found" }));
  await assert.rejects(installationToken(APP, 77, { fetch: gone.fetch }), GithubInstallationGoneError);
});

test("a user's installations are listed across pages", async () => {
  const fake = fakeFetch((url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    const installations =
      page === 1
        ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1, app_id: 4242, account: { login: `a${index}` } }))
        : [{ id: 501, app_id: 4242, account: { login: "acme" } }];
    return json(200, { installations });
  });
  const listed = await userInstallations("ghu_user", { fetch: fake.fetch });
  assert.equal(listed.length, 101);
  assert.deepEqual(listed.at(-1), { id: 501, account: "acme", appId: 4242, updatedAt: "" });
  assert.equal(fake.calls.length, 2);
});

test("the callback keeps an installation the user can reach, and picks this App's when GitHub omitted the id", async () => {
  const listed = [
    { id: 11, app_id: 1, account: { login: "other" }, updated_at: "2026-01-01T00:00:00Z" },
    { id: 77, app_id: 4242, account: { login: "acme" }, updated_at: "2026-09-30T12:00:00Z" },
    { id: 88, app_id: 4242, account: { login: "older" }, updated_at: "2026-01-01T00:00:00Z" },
  ];
  const fake = fakeFetch((url) => {
    if (url.includes("/user/installations?") || url.endsWith("/user/installations")) {
      return json(200, { installations: listed });
    }
    return json(404, { message: "Not Found" });
  });
  const named = await installationForUser(APP, "ghu_user", "77", { fetch: fake.fetch, retryDelayMs: 0 });
  assert.deepEqual(named, { id: 77, account: "acme", appId: 4242, updatedAt: "2026-09-30T12:00:00Z" });
  const omitted = await installationForUser(APP, "ghu_user", undefined, { fetch: fake.fetch, retryDelayMs: 0 });
  assert.equal(omitted.id, 77);
  await assert.rejects(installationForUser(APP, "ghu_user", "99", { fetch: fake.fetch, retryDelayMs: 0 }), /not one the authorizing user can reach/);
});

test("without an installation id, one install is kept, several open a picker, and none asks to install", async () => {
  const listed = [
    { id: 77, app_id: 4242, account: { login: "acme" }, updated_at: "2026-09-30T12:00:00Z" },
    { id: 88, app_id: 4242, account: { login: "other" }, updated_at: "2026-01-01T00:00:00Z" },
  ];
  const two = fakeFetch((url) => {
    if (url.includes("/user/installations?") || url.endsWith("/user/installations")) {
      return json(200, { installations: listed });
    }
    return json(404, { message: "Not Found" });
  });
  const picked = await resolveGithubInstallation(APP, "ghu_user", undefined, { fetch: two.fetch, retryDelayMs: 0 });
  assert.equal(picked.action, "pick");
  if (picked.action === "pick") {
    assert.deepEqual(picked.installations.map((item) => item.account), ["acme", "other"]);
  }
  const one = fakeFetch((url) => {
    if (url.includes("/user/installations?") || url.endsWith("/user/installations")) {
      return json(200, { installations: [listed[0]] });
    }
    return json(404, { message: "Not Found" });
  });
  const only = await resolveGithubInstallation(APP, "ghu_user", undefined, { fetch: one.fetch, retryDelayMs: 0 });
  assert.deepEqual(only, {
    action: "use",
    installation: { id: 77, account: "acme", appId: 4242, updatedAt: "2026-09-30T12:00:00Z" },
  });
  const none = fakeFetch(() => json(200, { installations: [] }));
  assert.deepEqual(await resolveGithubInstallation(APP, "ghu_user", undefined, { fetch: none.fetch, retryDelayMs: 0 }), {
    action: "install",
  });
  const named = await resolveGithubInstallation(APP, "ghu_user", "77", { fetch: two.fetch, retryDelayMs: 0 });
  assert.equal(named.action, "use");
  if (named.action === "use") {
    assert.equal(named.installation.id, 77);
  }
});

test("an installation missing from the list still counts when the user token can see it", async () => {
  const fake = fakeFetch((url) => {
    if (url.includes("/user/installations?") || /\/user\/installations$/.test(new URL(url).pathname)) {
      return json(200, { installations: [] });
    }
    if (url.includes("/user/installations/77/repositories")) {
      return json(200, { repositories: [] });
    }
    if (url.includes("/app/installations/77")) {
      return json(200, { id: 77, app_id: 4242, account: { login: "acme" }, updated_at: "2026-09-30T12:00:00Z" });
    }
    return json(404, { message: "Not Found" });
  });
  const found = await installationForUser(APP, "ghu_user", "77", { fetch: fake.fetch, retryDelayMs: 0 });
  assert.deepEqual(found, { id: 77, account: "acme", appId: 4242, updatedAt: "2026-09-30T12:00:00Z" });
});

test("code exchange omits redirect_uri unless the authorize hop set one", async () => {
  const fake = fakeFetch(() => json(200, { access_token: "ghu_user" }));
  await exchangeUserCode(APP, "code-1", { fetch: fake.fetch });
  assert.deepEqual(JSON.parse(String(fake.calls[0]?.init.body)), {
    client_id: APP.clientId,
    client_secret: APP.clientSecret,
    code: "code-1",
  });
  await exchangeUserCode(APP, "code-2", { fetch: fake.fetch, redirectUri: "https://guilds.run/api/mcp/oauth/callback" });
  assert.equal(
    (JSON.parse(String(fake.calls[1]?.init.body)) as { redirect_uri?: string }).redirect_uri,
    "https://guilds.run/api/mcp/oauth/callback",
  );
});

test("a repository needs a valid name and an https URL; a GitHub connection needs a github.com URL", () => {
  assert.deepEqual(validateRepositoryInput({ name: "shop", url: "https://git.example.com/shop.git" }), {
    name: "shop",
    url: "https://git.example.com/shop.git",
    defaultBranch: null,
    connectionId: null,
  });
  assert.throws(() => validateRepositoryInput({ name: "Shop", url: "https://github.com/a/b" }), /name must match/);
  assert.throws(() => validateRepositoryInput({ name: "shop", url: "git@github.com:a/b.git" }), /https git URL/);
  assert.throws(() => validateRepositoryInput({ name: "shop", url: "https://user:pw@github.com/a/b" }), /without credentials/);
  assert.throws(
    () => validateRepositoryInput({ name: "shop", url: "https://gitlab.com/a/b", connection_id: "conn_1" }),
    /https:\/\/github\.com\/<owner>\/<repository>/,
  );
  assert.throws(() => validateRepositoryInput({ name: "shop", url: "https://github.com/a/b", default_branch: "a..b" }), /default_branch/);
});

function connection(id: string, status: McpConnectionRow["status"], installationId: number): McpConnectionRow {
  const [ciphertext, nonce] = encryptPayload({ installation_id: installationId, account: "acme" }, MASTER);
  return connectionRow({ id, status, account_hint: "acme", ciphertext, nonce });
}

test("repository tokens: one per connection, limited to its repositories, refreshed near expiry", async () => {
  let now = new Date("2026-09-30T12:00:00Z");
  const saved: string[] = [];
  const db = {
    getMcpConnection: async (id: string) => connection(id, "connected", id === "conn_a" ? 11 : 22),
    saveMcpConnection: async (id: string) => {
      saved.push(id);
      return null;
    },
  };
  const minted: string[] = [];
  const permissions: unknown[] = [];
  const names: Record<number, string> = { 101: "acme/shop", 102: "acme/site", 201: "other/infra" };
  const fake = fakeFetch((url, init) => {
    const installation = /installations\/(\d+)\//.exec(url)![1];
    const body = JSON.parse(String(init.body)) as { repository_ids: number[]; permissions: unknown };
    const ids = body.repository_ids;
    permissions.push(body.permissions);
    minted.push(`${installation}:${ids.join(",")}`);
    return json(201, {
      token: `ghs_${installation}_${minted.length}`,
      expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
      repositories: ids.map((id) => ({ id, full_name: names[id] })),
    });
  });
  const tokens = new RepositoryTokens(
    db as never,
    [
      { name: "shop", url: "https://github.com/acme/shop", connection_id: "conn_a", github_id: 101 },
      { name: "site", url: "https://github.com/acme/site.git", connection_id: "conn_a", github_id: "102" },
      { name: "infra", url: "https://github.com/other/infra", connection_id: "conn_b", github_id: 201 },
      { name: "public", url: "https://git.example.com/public.git", connection_id: null },
    ],
    { app: APP, fetch: fake.fetch, masterKey: MASTER, now: () => now },
  );
  await tokens.mint();
  assert.deepEqual(minted, ["11:101,102", "22:201"]);
  assert.deepEqual(permissions, [
    { contents: "write", pull_requests: "write" },
    { contents: "write", pull_requests: "write" },
  ], "what a coding agent's git and gh need");
  assert.deepEqual(Object.keys(tokens.entries).sort(), ["infra", "shop", "site"]);
  assert.deepEqual(tokens.entries.site, {
    token: "ghs_11_1",
    expires_at: "2026-09-30T13:00:00.000Z",
    host: "github.com",
    path: "acme/site",
  });
  assert.equal(tokens.needsRefresh(), false);
  now = new Date(now.getTime() + 3_600_000 - TOKEN_REFRESH_MS + 1000);
  assert.equal(tokens.needsRefresh(), true);
  const files: Array<{ path: string; data: string }> = [];
  await tokens.write({
    writeFiles: async (entries) => {
      files.push(...entries);
    },
    moveFiles: async () => undefined,
    deleteFiles: async () => undefined,
  }, "a_1");
  assert.equal(files[0]?.path, "/run/guilds/a_1/git-tokens.json");
  assert.equal((JSON.parse(files[0]!.data) as { repositories: Record<string, unknown> }).repositories.shop !== undefined, true);
  assert.deepEqual(saved, []);
});

test("a repository stored without an id finds it by its path, and one GitHub renamed gets its current URL", async () => {
  const recorded: Array<[string, string, number, string]> = [];
  const db = {
    getMcpConnection: async (id: string) => connection(id, "connected", 11),
    recordGithubRepository: async (
      connectionId: string,
      name: string,
      repository: { githubId: number; url: string },
    ) => {
      recorded.push([connectionId, name, repository.githubId, repository.url]);
    },
  };
  const scoped: number[][] = [];
  const fake = fakeFetch((url, init) => {
    // GitHub answers an old path with the repository under its current name, past the redirect.
    if (url === "https://api.github.com/repos/acme/site") {
      return json(200, { id: 102, full_name: "acme/site" });
    }
    if (url === "https://api.github.com/repos/OldOwner/docs") {
      return json(200, { id: 103, full_name: "acme/docs" });
    }
    const body = JSON.parse(String(init.body)) as { repository_ids?: number[] };
    if (!body.repository_ids) {
      return json(201, { token: "ghs_list", expires_at: "2026-09-30T13:00:00Z" });
    }
    scoped.push(body.repository_ids);
    return json(201, {
      token: "ghs_scoped",
      expires_at: "2026-09-30T13:00:00Z",
      repositories: [
        { id: 101, full_name: "acme/shop" },
        { id: 102, full_name: "acme/site" },
        { id: 103, full_name: "acme/docs" },
      ],
    });
  });
  const rows: Array<Record<string, unknown>> = [
    { name: "shop", url: "https://github.com/OldName/old-shop", connection_id: "conn_a", github_id: 101 },
    { name: "site", url: "https://github.com/acme/site", connection_id: "conn_a" },
    { name: "docs", url: "https://github.com/OldOwner/docs", connection_id: "conn_a" },
  ];
  const tokens = new RepositoryTokens(db as never, rows, { app: APP, fetch: fake.fetch, masterKey: MASTER });
  await tokens.mint();
  assert.deepEqual(scoped, [[101, 102, 103]]);
  assert.equal(rows[0]!.url, "https://github.com/acme/shop");
  assert.equal(rows[1]!.github_id, 102);
  assert.equal(rows[2]!.url, "https://github.com/acme/docs");
  assert.equal(tokens.entries.shop?.path, "acme/shop");
  assert.equal(tokens.entries.docs?.path, "acme/docs");
  assert.deepEqual(recorded, [
    ["conn_a", "site", 102, "https://github.com/acme/site"],
    ["conn_a", "docs", 103, "https://github.com/acme/docs"],
    ["conn_a", "shop", 101, "https://github.com/acme/shop"],
  ]);
});

test("a repository the App no longer reaches is named, whether it has an id or not", async () => {
  const db = { getMcpConnection: async (id: string) => connection(id, "connected", 11) };
  const listing = (url: string) => url.endsWith("/installation/repositories?per_page=100&page=1");
  const reaches101 = fakeFetch((url, init) => {
    if (listing(url)) {
      return json(200, { repositories: [{ id: 101, name: "shop", full_name: "acme/shop", owner: { login: "acme" } }] });
    }
    if (url.startsWith("https://api.github.com/repos/")) {
      return json(404, { message: "Not Found" });
    }
    const body = JSON.parse(String(init.body)) as { repository_ids?: number[] };
    return body.repository_ids
      ? json(422, { message: "There is at least one repository that does not exist or is not accessible to the parent installation." })
      : json(201, { token: "ghs_list", expires_at: "2026-09-30T13:00:00Z" });
  });
  const unnamed = new RepositoryTokens(
    db as never,
    [{ name: "gone", url: "https://github.com/acme/gone", connection_id: "conn_a" }],
    { app: APP, fetch: reaches101.fetch, masterKey: MASTER },
  );
  await assert.rejects(
    unnamed.mint(),
    (error: unknown) =>
      error instanceof RepositoryAccessError && /the GitHub App installed for acme does not reach gone \(acme\/gone\)/.test(error.message),
  );
  const revoked = new RepositoryTokens(
    db as never,
    [
      { name: "shop", url: "https://github.com/acme/shop", connection_id: "conn_a", github_id: 101 },
      { name: "infra", url: "https://github.com/acme/infra", connection_id: "conn_a", github_id: 103 },
    ],
    { app: APP, fetch: reaches101.fetch, masterKey: MASTER },
  );
  await assert.rejects(
    revoked.mint(),
    (error: unknown) => error instanceof RepositoryAccessError && /does not reach infra \(acme\/infra\):/.test(error.message),
  );
});

test("a disconnected connection is refused; GitHub refusing the installation retires it as installation_gone", async () => {
  const retired: string[] = [];
  const offline = new RepositoryTokens(
    { getMcpConnection: async (id: string) => connection(id, "disconnected", 11) } as never,
    [{ name: "shop", url: "https://github.com/acme/shop", connection_id: "conn_a" }],
    { app: APP, masterKey: MASTER },
  );
  await assert.rejects(offline.mint(), (error: unknown) => error instanceof RepositoryAccessError && /disconnected/.test(error.message));
  const gone = new RepositoryTokens(
    {
      getMcpConnection: async (id: string) => connection(id, "connected", 11),
      retireLogin: async (_pool: unknown, login: { id: string }, failure: string) => {
        retired.push(`${login.id}:${failure}`);
      },
    } as never,
    [{ name: "shop", url: "https://github.com/acme/shop", connection_id: "conn_a", github_id: 101 }],
    { app: APP, masterKey: MASTER, fetch: fakeFetch(() => json(403, { message: "suspended" })).fetch },
  );
  await assert.rejects(gone.mint(), /now disconnected/);
  assert.deepEqual(retired, ["conn_a:installation_gone"]);
});

test("a login token reaches the repositories the login picked with every permission the installation grants; a login with none picked gets none", async () => {
  const bodies: unknown[] = [];
  const fake = fakeFetch((_url, init) => {
    bodies.push(JSON.parse(String(init.body)));
    return json(201, { token: "ghs_login", expires_at: "2026-09-30T13:00:00Z", repositories: [{ id: 101, full_name: "acme/shop" }] });
  });
  const login = (repositories: GithubRepositorySelection[]) => ({ ...connection("conn_a", "connected", 11), settings: { repositories } });
  const minted = await mintLoginToken(
    {} as never,
    login([{ name: "shop", url: "https://github.com/acme/shop", default_branch: "main", github_id: 101 }]),
    { app: APP, fetch: fake.fetch, masterKey: MASTER },
  );
  assert.equal(minted.token, "ghs_login");
  assert.equal(minted.expiresAt, "2026-09-30T13:00:00Z");
  assert.deepEqual([...minted.paths], [["shop", "acme/shop"]]);
  assert.deepEqual(bodies, [{ repository_ids: [101] }]);
  await assert.rejects(
    mintLoginToken({} as never, login([]), { app: APP, fetch: fake.fetch, masterKey: MASTER }),
    (error: unknown) => error instanceof RepositoryAccessError && /GitHub login for acme has no repositories picked/.test(error.message),
  );
  assert.equal(bodies.length, 1);
});

test("a GitHub login stores the repositories its coding agents clone", () => {
  const selected = validateGithubRepositories([
    { name: "shop", url: "https://github.com/acme/shop", github_id: 101 },
    { name: "site", url: "https://github.com/acme/site.git", default_branch: "trunk" },
  ]);
  assert.deepEqual(selected, [
    { name: "shop", url: "https://github.com/acme/shop", default_branch: "main", github_id: 101 },
    { name: "site", url: "https://github.com/acme/site.git", default_branch: "trunk" },
  ]);
  assert.throws(() => validateGithubRepositories([{ name: "shop", url: "https://git.example.com/shop" }]), /github.com/);
  assert.throws(
    () => validateGithubRepositories([{ name: "shop", url: "https://github.com/acme/shop", github_id: "shop" }]),
    /github_id must be a positive integer/,
  );
  const github = connectionRow({
    id: "conn_front",
    status: "connected",
    account_hint: "acme",
    settings: { repositories: selected },
  });
  const cloned = codingRepositories(
    [
      { name: "shop", url: "https://github.com/acme/shop", default_branch: "main", connection_id: "conn_front" },
      { name: "docs", url: "https://git.example.com/docs.git", default_branch: "main", connection_id: null },
    ],
    github,
  );
  assert.deepEqual(
    cloned.map((row) => [row.name, row.connection_id, row.github_id ?? null]),
    [
      ["shop", "conn_front", 101],
      ["site", "conn_front", null],
      ["docs", null, null],
    ],
  );
});
