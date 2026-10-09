import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  OAuthError,
  OAuthReauthError,
  accessExpired,
  accountHint,
  authorizationUrl,
  clientCoversRedirect,
  configuredClient,
  discover,
  ensureClient,
  serverDiscovery,
  envClient,
  exchangeCode,
  oauthCallbackHtml,
  oauthCallbackUrl,
  pendingOauth,
  pendingOauthPayload,
  pendingReplaces,
  pkcePair,
  refreshTokens,
  registerClient,
  startsBrowserOauth,
  storedClient,
  tokenPayload,
  tokenRedactions,
  type OAuthDiscovery,
} from "../../src/oauth/index.js";
import { CONNECTORS } from "../../src/connectors/index.js";
import { loadTextFixture } from "../helpers/fixtures.js";
import { mockFetch } from "../helpers/http.js";

const GMAIL_SCOPES = CONNECTORS.bySlug("gmail")!.manifest.auth.oauth!.scopes!;
const DRIVE_SCOPES = CONNECTORS.bySlug("drive")!.manifest.auth.oauth!.scopes!;

const GMAIL_SERVER = {
  id: "mcp_gmail",
  slug: "gmail",
  auth: "oauth",
  config: {},
};

const DRIVE_SERVER = {
  id: "mcp_drive",
  slug: "drive",
  auth: "oauth",
  config: { url: "https://drivemcp.googleapis.com/mcp/v1" },
};

function googleDiscoveryHandler(resource: string, extraScopes: string[]) {
  return (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/.well-known/oauth-protected-resource/mcp/v1") {
      return {
        status: 200,
        json: {
          resource,
          authorization_servers: ["https://accounts.google.com/"],
          scopes_supported: extraScopes,
        },
      };
    }
    if (path.endsWith("oauth-authorization-server")) {
      return {
        status: 200,
        json: {
          authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          token_endpoint: "https://oauth2.googleapis.com/token",
        },
      };
    }
    if ((init?.method ?? "GET") === "POST") {
      return { status: 500, json: { error: "no dcr" } };
    }
    return { status: 404 };
  };
}

const driveDiscoveryHandler = googleDiscoveryHandler("https://drivemcp.googleapis.com/mcp/v1", [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
]);

test("pkce pair is S256", () => {
  const [verifier, challenge] = pkcePair();
  const digest = createHash("sha256").update(verifier, "ascii").digest();
  assert.equal(challenge, digest.toString("base64url").replace(/=+$/, ""));
  assert.equal(startsBrowserOauth({ auth: "oauth", slug: "notion" }), true);
  assert.equal(startsBrowserOauth({ auth: "oauth", slug: "gmail" }), true);
  assert.equal(startsBrowserOauth({ auth: "oauth", slug: "drive" }), true);
  assert.equal(startsBrowserOauth({ auth: "oauth", slug: "other" }), true);
  assert.equal(startsBrowserOauth({ auth: "token", slug: "other" }), false);
});

test("oauth callback URL prefers PUBLIC_BASE_URL over the inbound hop", () => {
  const behindProxy = { protocol: "http", headers: { host: "orchestrator:8080" } };
  assert.equal(
    oauthCallbackUrl("https://guilds.run", behindProxy),
    "https://guilds.run/api/mcp/oauth/callback",
  );
  assert.equal(
    oauthCallbackUrl("https://guilds.run/", behindProxy),
    "https://guilds.run/api/mcp/oauth/callback",
  );
  assert.equal(
    oauthCallbackUrl("", { protocol: "http", headers: { host: "127.0.0.1:8080" } }),
    "http://127.0.0.1:8080/api/mcp/oauth/callback",
  );
});

test("authorization URL includes PKCE and resource", () => {
  const discovery: OAuthDiscovery = {
    resource: "https://mcp.notion.com",
    authorization_endpoint: "https://mcp.notion.com/authorize",
    token_endpoint: "https://mcp.notion.com/token",
    registration_endpoint: "https://mcp.notion.com/register",
    scopes: ["default"],
    access_type: null,
  };
  const url = authorizationUrl(discovery, {
    clientId: "cid",
    redirectUri: "http://127.0.0.1:8080/api/mcp/oauth/callback",
    codeChallenge: "challenge",
    state: "abc",
  });
  assert.ok(url.startsWith("https://mcp.notion.com/authorize?"));
  assert.ok(url.includes("code_challenge=challenge"));
  assert.ok(url.includes("code_challenge_method=S256"));
  assert.ok(url.includes("resource=https%3A%2F%2Fmcp.notion.com"));
  assert.ok(url.includes("scope=default"));
  assert.ok(url.includes("state=abc"));
  assert.ok(!url.includes("access_type="));
});

test("Gmail authorization URL is offline compose/readonly", () => {
  const discovery: OAuthDiscovery = {
    resource: "",
    authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    token_endpoint: "https://oauth2.googleapis.com/token",
    registration_endpoint: null,
    scopes: [...GMAIL_SCOPES],
    access_type: "offline",
  };
  const url = authorizationUrl(discovery, {
    clientId: "cid",
    redirectUri: "http://127.0.0.1:8080/api/mcp/oauth/callback",
    codeChallenge: "challenge",
    state: "abc",
  });
  assert.ok(url.includes("access_type=offline"));
  assert.ok(url.includes("gmail.readonly"));
  assert.ok(url.includes("gmail.compose"));
  assert.ok(!url.includes("resource="));
  assert.ok(!url.includes("mail.google.com"));
  assert.ok(!url.includes("gmail.modify"));
  assert.ok(!url.includes("trigger_onepick"));
});

test("Drive authorization URL is offline Drive scope without Google picker", () => {
  const discovery: OAuthDiscovery = {
    resource: "https://drivemcp.googleapis.com/mcp/v1",
    authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    token_endpoint: "https://oauth2.googleapis.com/token",
    registration_endpoint: null,
    scopes: [...DRIVE_SCOPES],
    access_type: "offline",
  };
  const url = authorizationUrl(discovery, {
    clientId: "cid",
    redirectUri: "http://127.0.0.1:8080/api/mcp/oauth/callback",
    codeChallenge: "challenge",
    state: "abc",
  });
  const params = new URL(url).searchParams;
  assert.equal(params.get("access_type"), "offline");
  assert.equal(params.get("scope"), DRIVE_SCOPES.join(" "));
  assert.equal(params.get("trigger_onepick"), null);
  assert.ok(params.get("scope")?.includes("auth/drive"));
  assert.ok(!url.includes("drive.file"));
});

test("token payload and account hint", () => {
  const now = new Date("2026-09-12T00:00:00.000Z");
  const stored = tokenPayload(
    {
      access_token: "tok",
      refresh_token: "ref",
      expires_in: 3600,
      email_domain: "acme.com",
      workspace_id: "ws_1",
    },
    { now },
  );
  assert.equal(stored.access_token, "tok");
  assert.equal(stored.refresh_token, "ref");
  assert.equal(stored.email_domain, "acme.com");
  assert.equal(accountHint(stored), "acme.com");
  assert.equal(accessExpired(stored, { now: new Date(now.getTime() + 2 * 60 * 60 * 1000) }), true);
  assert.equal(accessExpired(stored, { now: new Date(now.getTime() + 60 * 1000) }), false);
  const refreshed = tokenPayload({ access_token: "tok2", expires_in: 60 }, { now, existing: stored });
  assert.equal(refreshed.refresh_token, "ref");
  assert.equal(refreshed.access_token, "tok2");
});

test("token redactions and pending oauth", () => {
  const pending = pendingOauthPayload("verifier", "http://localhost/cb");
  assert.deepEqual(pendingOauth(pending), ["verifier", "http://localhost/cb"]);
  assert.equal(pendingReplaces(pending), false);
  const retry = pendingOauthPayload("verifier", "http://localhost/cb", true);
  assert.deepEqual(pendingOauth(retry), ["verifier", "http://localhost/cb"]);
  assert.equal(pendingReplaces(retry), true);
  assert.equal(pendingReplaces({ access_token: "tok" }), false);
  assert.equal(pendingReplaces({ access_token: "tok", oauth_replaces: true }), true);
  assert.deepEqual(tokenRedactions({ access_token: "tok", refresh_token: "ref" }, "conn_1"), {
    mcp_conn_1_access_token: "tok",
    mcp_conn_1_refresh_token: "ref",
  });
  assert.deepEqual(tokenRedactions({ token: "key" }, "conn_2"), { mcp_conn_2_token: "key" });
  assert.deepEqual(
    tokenRedactions(
      {
        evm_private_key: "0xabc",
        solana_private_key: "solsecret",
        alchemy_key: "alc",
        opensea_key: "os",
        uniswap_key: "uni",
      },
      "conn_3",
    ),
    {
      mcp_conn_3_evm_private_key: "0xabc",
      mcp_conn_3_solana_private_key: "solsecret",
      mcp_conn_3_alchemy_key: "alc",
      mcp_conn_3_opensea_key: "os",
      mcp_conn_3_uniswap_key: "uni",
    },
  );
  assert.deepEqual(
    tokenRedactions({ login: "pied-piper", secret_key: "sk-secret" }, "conn_4"),
    {
      mcp_conn_4_login: "pied-piper",
      mcp_conn_4_secret_key: "sk-secret",
    },
  );
});

test("stored client requires matching redirect", () => {
  const server = {
    config: {
      url: "https://mcp.notion.com/mcp",
      oauth_client: {
        client_id: "cid",
        redirect_uris: ["http://127.0.0.1:8080/api/mcp/oauth/callback"],
      },
    },
  };
  const client = storedClient(server);
  assert.ok(client);
  assert.equal(clientCoversRedirect(client, "http://127.0.0.1:8080/api/mcp/oauth/callback"), true);
  assert.equal(clientCoversRedirect(client, "http://localhost:8080/api/mcp/oauth/callback"), false);
});

test("discover follows protected resource metadata", async () => {
  const client = mockFetch((url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("oauth-protected-resource") || path.includes("oauth-protected-resource")) {
      return {
        status: 200,
        json: {
          resource: "https://mcp.notion.com",
          authorization_servers: ["https://mcp.notion.com"],
          scopes_supported: ["default"],
        },
      };
    }
    if (path.endsWith("oauth-authorization-server")) {
      return {
        status: 200,
        json: {
          authorization_endpoint: "https://mcp.notion.com/authorize",
          token_endpoint: "https://mcp.notion.com/token",
          registration_endpoint: "https://mcp.notion.com/register",
        },
      };
    }
    return { status: 404 };
  });
  const discovery = await discover("https://mcp.notion.com/mcp", { client });
  assert.equal(discovery.token_endpoint, "https://mcp.notion.com/token");
  assert.equal(discovery.registration_endpoint, "https://mcp.notion.com/register");
  assert.deepEqual(discovery.scopes, ["default"]);
});

test("register exchange and refresh", async () => {
  const client = mockFetch((url, init) => {
    const path = new URL(url).pathname;
    if (path === "/register") {
      return { status: 201, json: { client_id: "cid" } };
    }
    if (path === "/token") {
      const body = String(init?.body ?? "");
      if (body.includes("grant_type=authorization_code")) {
        assert.ok(body.includes("code_verifier=verifier"));
        return {
          status: 200,
          json: { access_token: "tok", refresh_token: "ref", expires_in: 3600 },
        };
      }
      if (body.includes("grant_type=refresh_token")) {
        return { status: 200, json: { access_token: "tok2" } };
      }
    }
    return { status: 404 };
  });
  const discovery: OAuthDiscovery = {
    resource: "https://mcp.notion.com",
    authorization_endpoint: "https://mcp.notion.com/authorize",
    token_endpoint: "https://mcp.notion.com/token",
    registration_endpoint: "https://mcp.notion.com/register",
    scopes: ["default"],
    access_type: null,
  };
  const registered = await registerClient(discovery, "http://127.0.0.1:8080/cb", { client });
  assert.equal(registered.client_id, "cid");
  const tokens = await exchangeCode(discovery, {
    code: "code",
    codeVerifier: "verifier",
    clientId: "cid",
    clientSecret: null,
    redirectUri: "http://127.0.0.1:8080/cb",
    client,
  });
  assert.equal(tokens.access_token, "tok");
  const refreshed = await refreshTokens(discovery, {
    refreshToken: "ref",
    clientId: "cid",
    clientSecret: null,
    client,
  });
  assert.equal(refreshed.access_token, "tok2");
});

test("refresh invalid_grant is reauth", async () => {
  const discovery: OAuthDiscovery = {
    resource: "https://mcp.notion.com",
    authorization_endpoint: "https://mcp.notion.com/authorize",
    token_endpoint: "https://mcp.notion.com/token",
    registration_endpoint: null,
    scopes: [],
    access_type: null,
  };
  await assert.rejects(
    () =>
      refreshTokens(discovery, {
        refreshToken: "ref",
        clientId: "cid",
        clientSecret: null,
        client: mockFetch(() => ({ status: 400, json: { error: "invalid_grant" } })),
      }),
    (error: unknown) => error instanceof OAuthReauthError,
  );
});

test("register 400 includes provider error", async () => {
  const discovery: OAuthDiscovery = {
    resource: "https://mcp.notion.com",
    authorization_endpoint: "https://mcp.notion.com/authorize",
    token_endpoint: "https://mcp.notion.com/token",
    registration_endpoint: "https://mcp.notion.com/register",
    scopes: [],
    access_type: null,
  };
  await assert.rejects(
    () =>
      registerClient(discovery, "http://guilds.run/api/mcp/oauth/callback", {
        client: mockFetch(() => ({
          status: 400,
          json: {
            error: "invalid_redirect_uri",
            error_description: "Redirect URI must use HTTPS unless it is a loopback HTTP URI",
          },
        })),
      }),
    /client registration failed: 400 invalid_redirect_uri/,
  );
});

test("register without endpoint fails", async () => {
  const discovery: OAuthDiscovery = {
    resource: "https://mcp.notion.com",
    authorization_endpoint: "https://mcp.notion.com/authorize",
    token_endpoint: "https://mcp.notion.com/token",
    registration_endpoint: null,
    scopes: [],
    access_type: null,
  };
  await assert.rejects(() => registerClient(discovery, "http://127.0.0.1:8080/cb"), /dynamic client registration/);
});

test("gmail env client", () => {
  const empty = {};
  assert.equal(envClient(GMAIL_SERVER, empty), null);
  assert.equal(configuredClient(GMAIL_SERVER, empty), null);
  const env = { GMAIL_OAUTH_CLIENT_ID: "gid", GMAIL_OAUTH_CLIENT_SECRET: "gsecret" };
  assert.deepEqual(envClient(GMAIL_SERVER, env), { client_id: "gid", client_secret: "gsecret" });
  assert.equal(configuredClient(GMAIL_SERVER, env)?.client_id, "gid");
  assert.deepEqual(envClient(DRIVE_SERVER, env), { client_id: "gid", client_secret: "gsecret" });
  assert.equal(envClient({ slug: "notion", config: {} }, env), null);
});

test("a connector with no endpoint discovers its provider's OAuth endpoints", async () => {
  const discovery = await serverDiscovery(GMAIL_SERVER, {
    client: mockFetch(() => {
      throw new Error("gmail discovery must not fetch MCP metadata");
    }),
  });
  assert.equal(discovery.resource, "");
  assert.equal(discovery.authorization_endpoint, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(discovery.token_endpoint, "https://oauth2.googleapis.com/token");
  assert.equal(discovery.registration_endpoint, null);
  assert.deepEqual(discovery.scopes, [...GMAIL_SCOPES]);
  await assert.rejects(() => serverDiscovery({ slug: "custom", auth: "oauth", config: {} }), /missing a url/);
});

test("ensureClient gmail uses env and restricts scopes", async () => {
  const db = {
    async updateMcpServerConfig(): Promise<null> {
      throw new Error("gmail must not persist a catalog oauth client");
    },
    async saveMcpConnection(): Promise<null> {
      return null;
    },
  };
  const [discovery, registered] = await ensureClient(
    db,
    GMAIL_SERVER,
    "http://127.0.0.1:8080/api/mcp/oauth/callback",
    {
      client: mockFetch(() => {
        throw new Error("gmail must not fetch MCP metadata");
      }),
      env: { GMAIL_OAUTH_CLIENT_ID: "gid", GMAIL_OAUTH_CLIENT_SECRET: "gsecret" },
    },
  );
  assert.deepEqual(registered, { client_id: "gid", client_secret: "gsecret" });
  assert.deepEqual(discovery.scopes, [...GMAIL_SCOPES]);
  assert.equal(discovery.access_type, "offline");
  const url = authorizationUrl(discovery, {
    clientId: String(registered.client_id),
    redirectUri: "http://127.0.0.1:8080/api/mcp/oauth/callback",
    codeChallenge: "challenge",
    state: "abc",
  });
  assert.ok(url.includes("access_type=offline"));
  assert.ok(!url.includes("resource="));
  assert.ok(!url.includes("mail.google.com"));
});

test("ensureClient drive uses env and restricts scopes", async () => {
  const db = {
    async updateMcpServerConfig(): Promise<null> {
      throw new Error("drive must not persist a catalog oauth client");
    },
    async saveMcpConnection(): Promise<null> {
      return null;
    },
  };
  const [discovery, registered] = await ensureClient(
    db,
    DRIVE_SERVER,
    "http://127.0.0.1:8080/api/mcp/oauth/callback",
    {
      client: mockFetch(driveDiscoveryHandler),
      env: { GMAIL_OAUTH_CLIENT_ID: "gid", GMAIL_OAUTH_CLIENT_SECRET: "gsecret" },
    },
  );
  assert.deepEqual(registered, { client_id: "gid", client_secret: "gsecret" });
  assert.deepEqual(discovery.scopes, [...DRIVE_SCOPES]);
  assert.equal(discovery.access_type, "offline");
  const url = authorizationUrl(discovery, {
    clientId: String(registered.client_id),
    redirectUri: "http://127.0.0.1:8080/api/mcp/oauth/callback",
    codeChallenge: "challenge",
    state: "abc",
  });
  const params = new URL(url).searchParams;
  assert.equal(params.get("access_type"), "offline");
  assert.equal(params.get("scope"), DRIVE_SCOPES.join(" "));
  assert.equal(params.get("trigger_onepick"), null);
  assert.ok(!params.get("scope")?.includes("drive.file"));
});

test("ensureClient gmail without env fails", async () => {
  const db = {
    async updateMcpServerConfig(): Promise<null> {
      return null;
    },
    async saveMcpConnection(): Promise<null> {
      return null;
    },
  };
  await assert.rejects(
    () =>
      ensureClient(db, GMAIL_SERVER, "http://127.0.0.1:8080/api/mcp/oauth/callback", {
        env: {},
      }),
    (error: unknown) => error instanceof OAuthError && /OAuth client is not configured/.test(error.message),
  );
});

test("oauth callback HTML matches the recorded fixtures", () => {
  assert.equal(
    oauthCallbackHtml({
      success: false,
      title: "Authorization Cancelled",
      message: "The authorization request was cancelled or incomplete.",
    }).trimEnd(),
    loadTextFixture("http/oauth-callback-cancelled.html").trimEnd(),
  );
  assert.equal(
    oauthCallbackHtml({
      success: false,
      title: "Session Expired",
      message: "This authorization request has expired or was already completed. Please try connecting again.",
    }).trimEnd(),
    loadTextFixture("http/oauth-callback-expired.html").trimEnd(),
  );
});
