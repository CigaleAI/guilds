import { createHash, randomBytes } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { proxyFetch, type FetchFn } from "../net/http.js";
import { decryptPayload, encryptPayload } from "../credentials/crypto.js";
import { githubAppConfig } from "../github/index.js";
import {
  GOOGLE_CONNECTORS,
  integrationValues,
  type Integration,
  type IntegrationSources,
} from "../instance/integrations.js";
import { saveOauthClient, type LoadedConnector } from "../connectors/servers.js";
import { saveMcpConnection, type McpConnectionRow } from "../db/mcp.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import { keepMatching } from "../lib/decode.js";
import { isJsonObject, type JsonObject } from "../lib/json.js";
import type { Manifest, OAuthClient, OAuthClientCredentials } from "../db/schema/index.js";
import { connectorIntegration } from "../connectors/instance.js";

/** An instance integration that holds an OAuth client: its fields, and how its provider authorizes. */
type OAuthProvider = {
  integration: Integration;
  clientId: string;
  clientSecret: string;
  /** How a connector with no endpoint of its own discovers the provider's authorization server; null for a client of the connector's own, which discovers from its endpoint. */
  discovery: OAuthDiscovery | null;
  accessType: string | null;
};

const OAUTH_PROVIDERS = {
  [GOOGLE_CONNECTORS.id]: {
    integration: GOOGLE_CONNECTORS,
    clientId: "client_id",
    clientSecret: "client_secret",
    discovery: {
      resource: "",
      authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      token_endpoint: "https://oauth2.googleapis.com/token",
      registration_endpoint: null,
      scopes: [],
      access_type: null,
    },
    accessType: "offline",
  },
} satisfies Record<Integration["id"], OAuthProvider>;

/** The effective manifest's OAuth block for a server, or null for a non-OAuth one. */
function manifestOauth(server: LoadedConnector): NonNullable<Manifest["auth"]["oauth"]> | null {
  return server.manifest.auth.oauth ?? null;
}

/**
 * The integration that holds a server's OAuth client: the shipped one its manifest's provider
 * names, or, for a configured client with no provider, the connector's own.
 */
function providerOf(server: LoadedConnector): OAuthProvider | null {
  const manifest = server.manifest;
  const oauth = manifest.auth.oauth;
  if (!oauth) {
    return null;
  }
  if (oauth.provider) {
    return OAUTH_PROVIDERS[oauth.provider] ?? null;
  }
  if (oauth.strategy !== "configured") {
    return null;
  }
  const integration = connectorIntegration(manifest);
  return integration
    ? { integration, clientId: "client_id", clientSecret: "client_secret", discovery: null, accessType: null }
    : null;
}

/** Whether the server's login is the platform GitHub App's installation flow. */
export function isGithubApp(server: LoadedConnector): boolean {
  return manifestOauth(server)?.strategy === "github_app";
}

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

export class OAuthReauthError extends OAuthError {
  constructor(message: string) {
    super(message);
    this.name = "OAuthReauthError";
  }
}

export type OAuthDiscovery = {
  resource: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string | null;
  scopes: string[];
  access_type: string | null;
};

/**
 * How OAuth requests reach a provider: through `client`, or else through the proxy at
 * `proxyUrl`, or directly when neither is set.
 */
export type OAuthHttp = {
  client?: FetchFn | undefined;
  proxyUrl?: string | undefined;
};

/** The services a login's OAuth client is resolved and registered through: the network, and the instance's integration values. */
export type OAuthClientServices = OAuthHttp & {
  sources?: IntegrationSources | undefined;
};

/** The services a login's tokens are refreshed through: the network, and the cipher of its stored payload. */
export type TokenRefreshServices = OAuthHttp & {
  decrypt: (ciphertext: Buffer, nonce: Buffer) => JsonObject;
  encrypt?: typeof encryptPayload;
};

/** The request a login started from, as far as its callback URL needs it: its protocol and Host header. */
export type RequestOrigin = {
  protocol: string;
  headers: { host?: string | string[] | undefined };
};

/** The parameters of an authorization request a login sends the operator's browser to. */
export type AuthorizationRequest = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
};

/** An authorization code grant: the code, the PKCE verifier it was requested with, and the client that trades it. */
export type AuthorizationCodeGrant = {
  code: string;
  codeVerifier: string;
  clientId: string;
  clientSecret?: string | null | undefined;
  redirectUri: string;
};

/** A refresh token grant: the refresh token and the client that trades it. */
export type RefreshTokenGrant = {
  refreshToken: string;
  clientId: string;
  clientSecret?: string | null | undefined;
};

export class OAuthUnsupportedError extends OAuthError {
  constructor(message: string) {
    super(message);
    this.name = "OAuthUnsupportedError";
  }
}

export function oauthStrategy(server: LoadedConnector): "none" | "dynamic" | "configured" {
  const explicit = server.oauth_strategy;
  if (explicit === "dynamic" || explicit === "configured" || explicit === "none") {
    return explicit;
  }
  if (server.auth !== "oauth") {
    return "none";
  }
  const strategy = manifestOauth(server)?.strategy;
  return strategy === "configured" || strategy === "github_app" ? "configured" : "dynamic";
}

export function startsBrowserOauth(server: LoadedConnector): boolean {
  return server.auth === "oauth";
}

export function oauthSetupState(
  server: LoadedConnector,
  sources?: IntegrationSources,
): "not_applicable" | "dynamic" | "configured" | "unsupported" {
  if (isGithubApp(server)) {
    return githubAppConfig(sources) ? "configured" : "unsupported";
  }
  const strategy = oauthStrategy(server);
  if (strategy === "none" || server.auth !== "oauth") {
    return "not_applicable";
  }
  if (configuredClient(server, sources)) {
    return "configured";
  }
  if (strategy === "configured") {
    return "unsupported";
  }
  return "dynamic";
}

function urlsafe(raw: Buffer): string {
  return raw.toString("base64url").replace(/=+$/, "");
}

export function pkcePair(): [string, string] {
  const verifier = urlsafe(randomBytes(32));
  const digest = createHash("sha256").update(verifier, "ascii").digest();
  return [verifier, urlsafe(digest)];
}

export function newState(): string {
  return urlsafe(randomBytes(32));
}

export function oauthCallbackUrl(
  publicBaseUrl: string,
  request: RequestOrigin,
): string {
  const base = publicBaseUrl.trim().replace(/\/+$/, "");
  if (base) {
    return `${base}/api/mcp/oauth/callback`;
  }
  const host = String(request.headers.host ?? "127.0.0.1");
  return `${request.protocol}://${host}/api/mcp/oauth/callback`;
}

export function authorizationUrl(
  discovery: OAuthDiscovery,
  options: AuthorizationRequest,
): string {
  const params = new URLSearchParams();
  params.set("response_type", "code");
  params.set("client_id", options.clientId);
  params.set("redirect_uri", options.redirectUri);
  params.set("state", options.state);
  params.set("code_challenge", options.codeChallenge);
  params.set("code_challenge_method", "S256");
  params.set("prompt", "consent");
  if (discovery.resource) {
    params.set("resource", discovery.resource);
  }
  if (discovery.scopes.length) {
    params.set("scope", discovery.scopes.join(" "));
  }
  if (discovery.access_type) {
    params.set("access_type", discovery.access_type);
  }
  return `${discovery.authorization_endpoint}?${params.toString()}`;
}

/** The OAuth client the connector registered, or null when it registered none. */
export function storedClient(server: LoadedConnector): OAuthClient | null {
  return server.config.oauth_client ?? null;
}

/** The OAuth client the manifest's provider integration holds, or null while that integration is off. */
export function providerClient(
  server: LoadedConnector,
  sources?: IntegrationSources,
): OAuthClientCredentials | null {
  const provider = providerOf(server);
  if (provider === null) {
    return null;
  }
  const values = integrationValues(provider.integration, sources);
  if (values === null) {
    return null;
  }
  return { client_id: values[provider.clientId] ?? "", client_secret: values[provider.clientSecret] ?? null };
}

export function configuredClient(
  server: LoadedConnector,
  sources?: IntegrationSources,
): OAuthClientCredentials | null {
  return storedClient(server) ?? providerClient(server, sources);
}

export function clientCoversRedirect(client: OAuthClient, redirectUri: string): boolean {
  return client.redirect_uris.includes(redirectUri);
}

/** The account a login signed in as, as far as its provider names it; a token response that leaves one out keeps the one it replaces. */
const ACCOUNT_FIELDS = {
  user_id: Type.Optional(Type.String({ minLength: 1 })),
  workspace_id: Type.Optional(Type.String({ minLength: 1 })),
  email_domain: Type.Optional(Type.String({ minLength: 1 })),
};

/** What a provider's token endpoint answers a grant with (RFC 6749 §5.1): the access token, and the rest when it names them. */
const TokenResponse = Type.Object({
  access_token: Type.String({ minLength: 1 }),
  refresh_token: Type.Optional(Type.String({ minLength: 1 })),
  expires_in: Type.Optional(Type.Integer()),
  token_type: Type.Optional(Type.String({ minLength: 1 })),
  scope: Type.Optional(Type.String()),
  ...ACCOUNT_FIELDS,
});
export type TokenResponse = Static<typeof TokenResponse>;

/**
 * The token payload a login stores from its provider's token responses: the access token and its type, the refresh token,
 * expiry and account when the provider names them, and whether its sign-in replaced a login that signed in before.
 */
const LoginTokens = Type.Object({
  access_token: Type.String({ minLength: 1 }),
  refresh_token: Type.Optional(Type.String({ minLength: 1 })),
  token_type: Type.String({ minLength: 1 }),
  expires_at: Type.Optional(Type.String({ minLength: 1 })),
  ...ACCOUNT_FIELDS,
  oauth_replaces: Type.Optional(Type.Literal(true)),
});
export type LoginTokens = Static<typeof LoginTokens>;

/** What a stored login's payload holds of its tokens: each field of them it has, as the field is typed. */
const StoredTokens = Type.Partial(LoginTokens);
export type StoredTokens = Static<typeof StoredTokens>;

/** The tokens a stored login's payload holds; a field of another type is one it does not hold. */
function storedTokens(payload: JsonObject): StoredTokens {
  return keepMatching(StoredTokens, payload) ?? {};
}

/** The instant a token response's `expires_in` ends, counted from `now`, or null when it names none. */
function expiryOf(tokens: TokenResponse, now: Date): string | null {
  return tokens.expires_in === undefined ? null : new Date(now.getTime() + tokens.expires_in * 1000).toISOString();
}

/**
 * The payload a login stores from a token response received at `now`: the fields the response
 * leaves out are kept from `existing`, the payload it replaces.
 */
export function tokenPayload(tokens: TokenResponse, now: Date, existing: StoredTokens = {}): LoginTokens {
  const { expires_in: _expiresIn, scope: _scope, ...response } = tokens;
  const expiresAt = expiryOf(tokens, now);
  return {
    ...existing,
    ...response,
    token_type: response.token_type ?? "Bearer",
    ...(expiresAt === null ? {} : { expires_at: expiresAt }),
  };
}

/** The account a login's tokens name for the operator: its email domain, else its workspace; empty when they name neither. */
export function accountHint(tokens: LoginTokens): string {
  return tokens.email_domain?.trim() || tokens.workspace_id?.trim() || "";
}

/** The secrets a login's payload holds, whatever its connector: each one a string where the payload has it. */
const LoginSecrets = Type.Partial(
  Type.Object({
    access_token: Type.String(),
    refresh_token: Type.String(),
    token: Type.String(),
    evm_private_key: Type.String(),
    solana_private_key: Type.String(),
    alchemy_key: Type.String(),
    opensea_key: Type.String(),
    uniswap_key: Type.String(),
    login: Type.String(),
    secret_key: Type.String(),
  }),
);

/** The payload fields of a login that hold a secret, whatever its connector. */
export const TOKEN_FIELDS: readonly string[] = Object.keys(LoginSecrets.properties);

/** The secrets a login's payload holds, each one named for the connection and field it is redacted as. */
export function tokenRedactions(payload: JsonObject, connectionId: string): Record<string, string> {
  const secrets = Object.entries(keepMatching(LoginSecrets, payload) ?? {}).filter(([, value]) => value);
  return Object.fromEntries(secrets.map(([key, value]) => [`mcp_${connectionId}_${key}`, value]));
}

/**
 * The tokens a connection stores, as redaction values, decrypted with `masterKey` or the
 * environment's key; a payload that cannot be read holds none.
 */
export function storedTokenRedactions(connection: McpConnectionRow, masterKey?: Buffer): Record<string, string> {
  try {
    return tokenRedactions(decryptPayload(connection.ciphertext, connection.nonce, masterKey), connection.id);
  } catch {
    return {};
  }
}

/** Whether a login's access token has expired at `now`, or expires within `skewMs` of it. */
export function accessExpired(payload: JsonObject, now: Date, skewMs = 60_000): boolean {
  const expiresAt = storedTokens(payload).expires_at;
  if (expiresAt === undefined) {
    return false;
  }
  const expires = Date.parse(expiresAt);
  if (Number.isNaN(expires)) {
    return false;
  }
  return now.getTime() + skewMs >= expires;
}

/** A sign-in under way: the PKCE verifier it was requested with, the URL the provider returns to, and whether it replaces a login. */
const PendingSignIn = Type.Object({
  code_verifier: Type.String(),
  redirect_uri: Type.String(),
  replaces: Type.Boolean(),
});
export type PendingSignIn = Static<typeof PendingSignIn>;

/** The payload a login holds while its sign-in is under way: the sign-in, under `oauth`. */
export type PendingSignInPayload = { oauth: PendingSignIn };

/** What a login's payload holds of a sign-in under way, and whether its tokens were stored by a sign-in that replaced a login. */
const StoredSignIn = Type.Object({
  oauth: Type.Optional(Type.Partial(PendingSignIn)),
  oauth_replaces: Type.Optional(Type.Literal(true)),
});

/** The sign-in a login's payload holds; a field of another type is one it does not hold. */
function storedSignIn(payload: JsonObject): Static<typeof StoredSignIn> {
  return keepMatching(StoredSignIn, payload) ?? {};
}

export function pendingOauthPayload(codeVerifier: string, redirectUri: string, replaces = false): PendingSignInPayload {
  return { oauth: { code_verifier: codeVerifier, redirect_uri: redirectUri, replaces } };
}

export function pendingReplaces(payload: JsonObject): boolean {
  const stored = storedSignIn(payload);
  return stored.oauth_replaces === true || stored.oauth?.replaces === true;
}

export function pendingOauth(payload: JsonObject): [string, string] {
  const signIn = storedSignIn(payload).oauth;
  if (signIn?.code_verifier === undefined || signIn.redirect_uri === undefined) {
    throw new OAuthError("connection is missing oauth state");
  }
  return [signIn.code_verifier, signIn.redirect_uri];
}

function resourceMetadataUrls(mcpUrl: string): string[] {
  const parsed = new URL(mcpUrl);
  const origin = parsed.origin;
  const path = parsed.pathname.replace(/\/+$/, "");
  const resourcePath = ".well-known/oauth-protected-resource";
  const base = mcpUrl.endsWith("/") ? mcpUrl : `${mcpUrl}/`;
  const urls = [new URL(resourcePath, base).toString()];
  if (path) {
    urls.push(`${origin}/.well-known/oauth-protected-resource${path}`);
  }
  urls.push(`${origin}/.well-known/oauth-protected-resource`);
  const seen: string[] = [];
  for (const url of urls) {
    if (!seen.includes(url)) {
      seen.push(url);
    }
  }
  return seen;
}

function authServerMetadataUrl(issuer: string): string {
  const parsed = new URL(issuer.replace(/\/+$/, ""));
  return `${parsed.origin}/.well-known/oauth-authorization-server`;
}

/** The JSON object `text` holds, or null when it is not JSON or holds anything else. */
function parseJsonObject(text: string): JsonObject | null {
  try {
    const payload: unknown = JSON.parse(text);
    return isJsonObject(payload) ? payload : null;
  } catch {
    return null;
  }
}

/** The first JSON object one of `urls` answers, tried in order. */
async function getJson(fetchFn: FetchFn, urls: string[]): Promise<JsonObject> {
  let last = "discovery failed";
  for (const url of urls) {
    const response = await fetchFn(url, { method: "GET", headers: { Accept: "application/json" } });
    if (response.status >= 400) {
      last = `discovery failed: ${response.status}`;
      continue;
    }
    const payload = parseJsonObject(await response.text());
    if (payload !== null) {
      return payload;
    }
    last = "discovery returned a non-object";
  }
  throw new OAuthError(last);
}

/** The fetch OAuth requests go through: `http.client`, or else the proxy, or else a direct fetch. */
function oauthFetch(http: OAuthHttp): FetchFn {
  return http.client ?? proxyFetch(http.proxyUrl ?? "");
}

/** A protected resource's metadata (RFC 9728), as far as a login reads it: the resource it names, its authorization servers, and the scopes it supports. */
const ProtectedResourceMetadata = Type.Object({
  resource: Type.Optional(Type.String()),
  authorization_servers: Type.Array(Type.String()),
  scopes_supported: Type.Optional(Type.Array(Type.String())),
});

/** What a login reads of a protected resource's metadata: the resource it names, its first authorization server, and the scopes it supports when it names them. */
type ProtectedResource = { resource: string; authorizationServer: string; scopes: string[] | null };

/** The protected resource `metadata` describes, the resource defaulting to `mcpUrl`. */
function protectedResourceOf(metadata: JsonObject, mcpUrl: string): ProtectedResource {
  const parsed = keepMatching(ProtectedResourceMetadata, metadata);
  const authorizationServer = parsed?.authorization_servers[0];
  if (parsed === null || authorizationServer === undefined) {
    throw new OAuthError("protected resource metadata is missing authorization_servers");
  }
  return {
    resource: parsed.resource?.trim() || mcpUrl,
    authorizationServer,
    scopes: parsed.scopes_supported ?? null,
  };
}

/** An authorization server's metadata (RFC 8414), as far as a login reads it: its endpoints, and the scopes it supports. */
const AuthorizationServerMetadata = Type.Object({
  authorization_endpoint: Type.String(),
  token_endpoint: Type.String(),
  registration_endpoint: Type.Optional(Type.String()),
  scopes_supported: Type.Optional(Type.Array(Type.String())),
});

function scopedDiscovery(server: LoadedConnector, discovery: OAuthDiscovery): OAuthDiscovery {
  const scopes = manifestOauth(server)?.scopes;
  if (!scopes?.length) {
    return discovery;
  }
  return {
    ...discovery,
    scopes: [...scopes],
    access_type: providerOf(server)?.accessType ?? discovery.access_type,
  };
}

/**
 * The authorization server for a server's logins: discovered from its endpoint, or, for a
 * connector with no endpoint, the one its provider integration names.
 */
export async function serverDiscovery(
  server: LoadedConnector,
  options: OAuthHttp = {},
): Promise<OAuthDiscovery> {
  const url = server.config.url?.trim();
  if (url) {
    return scopedDiscovery(server, await discover(url, options));
  }
  const provider = providerOf(server);
  if (provider === null || provider.discovery === null) {
    throw new OAuthError("mcp server is missing a url");
  }
  return scopedDiscovery(server, { ...provider.discovery });
}

export async function discover(
  mcpUrl: string,
  options: OAuthHttp = {},
): Promise<OAuthDiscovery> {
  const fetchFn = oauthFetch(options);
  const resourceMetadata = await getJson(fetchFn, resourceMetadataUrls(mcpUrl));
  const { resource, authorizationServer, scopes } = protectedResourceOf(resourceMetadata, mcpUrl);
  const serverMetadata = await getJson(fetchFn, [authServerMetadataUrl(authorizationServer)]);
  const metadata = keepMatching(AuthorizationServerMetadata, serverMetadata);
  if (metadata === null) {
    throw new OAuthError("authorization server metadata is missing endpoints");
  }
  return {
    resource,
    authorization_endpoint: metadata.authorization_endpoint.trim(),
    token_endpoint: metadata.token_endpoint.trim(),
    registration_endpoint: metadata.registration_endpoint?.trim() || null,
    scopes: scopes ?? metadata.scopes_supported ?? [],
    access_type: null,
  };
}

/** What a dynamic client registration answers (RFC 7591 §3.2.1): the client's id, and a secret when the server issues one. */
const ClientRegistration = Type.Object({ client_id: Type.String(), client_secret: Type.Optional(Type.String()) });

export async function registerClient(
  discovery: OAuthDiscovery,
  redirectUri: string,
  options: OAuthHttp = {},
): Promise<OAuthClient> {
  if (!discovery.registration_endpoint) {
    throw new OAuthError("authorization server does not support dynamic client registration");
  }
  const response = await oauthFetch(options)(discovery.registration_endpoint, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "guilds.run",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const text = await response.text();
  if (response.status >= 400) {
    const error = await tokenError(response, text);
    throw new OAuthError(
      error ? `client registration failed: ${response.status} ${error}` : `client registration failed: ${response.status}`,
    );
  }
  const payload: unknown = text ? JSON.parse(text) : {};
  const registration = isJsonObject(payload) ? keepMatching(ClientRegistration, payload) : null;
  if (registration === null) {
    throw new OAuthError("client registration did not return a client_id");
  }
  return {
    client_id: registration.client_id,
    client_secret: registration.client_secret ?? null,
    redirect_uris: [redirectUri],
  };
}

/** What a provider answers a request it refuses with (RFC 6749 §5.2): the error code. */
const ErrorResponse = Type.Object({ error: Type.String() });

async function tokenError(response: Response, text: string): Promise<string | null> {
  const payload = parseJsonObject(text);
  const refusal = payload === null ? null : keepMatching(ErrorResponse, payload);
  return refusal?.error ?? null;
}

async function tokenRequest(
  discovery: OAuthDiscovery,
  fields: Record<string, string>,
  clientSecret: string | null | undefined,
  http: OAuthHttp,
): Promise<TokenResponse> {
  const params = new URLSearchParams(fields);
  if (clientSecret) {
    params.set("client_secret", clientSecret);
  }
  const response = await oauthFetch(http)(discovery.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
  });
  const text = await response.text();
  if (response.status >= 400) {
    const error = await tokenError(response, text);
    if (error === "invalid_grant") {
      throw new OAuthReauthError("refresh token was rejected");
    }
    throw new OAuthError(`token request failed: ${response.status}`);
  }
  const payload: unknown = text ? JSON.parse(text) : {};
  if (!isJsonObject(payload)) {
    throw new OAuthError("token response is not an object");
  }
  const tokens = keepMatching(TokenResponse, payload);
  if (tokens === null) {
    throw new OAuthError("token response is missing access_token");
  }
  return tokens;
}

export async function exchangeCode(
  discovery: OAuthDiscovery,
  grant: AuthorizationCodeGrant,
  http: OAuthHttp = {},
): Promise<TokenResponse> {
  return tokenRequest(
    discovery,
    {
      grant_type: "authorization_code",
      code: grant.code,
      client_id: grant.clientId,
      redirect_uri: grant.redirectUri,
      code_verifier: grant.codeVerifier,
      ...(discovery.resource ? { resource: discovery.resource } : {}),
    },
    grant.clientSecret,
    http,
  );
}

export async function refreshTokens(
  discovery: OAuthDiscovery,
  grant: RefreshTokenGrant,
  http: OAuthHttp = {},
): Promise<TokenResponse> {
  return tokenRequest(
    discovery,
    {
      grant_type: "refresh_token",
      refresh_token: grant.refreshToken,
      client_id: grant.clientId,
      ...(discovery.resource ? { resource: discovery.resource } : {}),
    },
    grant.clientSecret,
    http,
  );
}

/** The db/ functions a login's OAuth client and tokens are saved through, on `db`. */
function oauthDatabase(db: Queryable) {
  return {
    saveOauthClient: bindQuery(db, saveOauthClient),
    saveMcpConnection: bindQuery(db, saveMcpConnection),
  };
}

export type OauthDatabase = ReturnType<typeof oauthDatabase>;

/**
 * The provider's discovery and the OAuth client a login to `server` signs in with at
 * `redirectUri`: the stored, the provided, or the configured client, or one registered now and
 * saved on `db`.
 */
export async function ensureClient(
  db: Queryable,
  server: LoadedConnector,
  redirectUri: string,
): Promise<[OAuthDiscovery, OAuthClientCredentials]> {
  return ensureClientThrough(oauthDatabase(db), server, redirectUri);
}

/**
 * The provider's discovery and the OAuth client a login to `server` signs in with at
 * `redirectUri`, saved through `db`, the dependencies object a unit test fakes, and fetched
 * and read through `services`.
 */
export async function ensureClientThrough(
  db: OauthDatabase,
  server: LoadedConnector,
  redirectUri: string,
  services: OAuthClientServices = {},
): Promise<[OAuthDiscovery, OAuthClientCredentials]> {
  const strategy = oauthStrategy(server);
  if (strategy === "none" || server.auth !== "oauth") {
    throw new OAuthUnsupportedError("connector is not oauth");
  }
  const discovery = await serverDiscovery(server, services);
  const current = storedClient(server);
  if (current !== null && clientCoversRedirect(current, redirectUri)) {
    return [discovery, current];
  }
  const provided = providerClient(server, services.sources);
  if (provided !== null) {
    return [discovery, provided];
  }
  if (strategy === "configured") {
    throw new OAuthUnsupportedError("OAuth client is not configured");
  }
  if (!discovery.registration_endpoint) {
    throw new OAuthUnsupportedError(
      "authorization server does not support dynamic client registration and no client is configured",
    );
  }
  const registered = await registerClient(discovery, redirectUri, services);
  await db.saveOauthClient(server.id, registered, new Date());
  return [discovery, registered];
}

/** Refreshes a login's tokens at its provider and saves them, encrypted, through `db`. */
export async function refreshConnection(
  db: OauthDatabase,
  connection: McpConnectionRow,
  server: LoadedConnector,
  services: TokenRefreshServices,
): Promise<McpConnectionRow> {
  const now = new Date();
  const payload = storedTokens(services.decrypt(connection.ciphertext, connection.nonce));
  const refresh = payload.refresh_token;
  if (refresh === undefined) {
    throw new OAuthReauthError("connection has no refresh token");
  }
  const discovery = await serverDiscovery(server, services);
  const client = configuredClient(server);
  if (client === null) {
    throw new OAuthError("mcp server is missing an oauth client");
  }
  const tokens = await refreshTokens(
    discovery,
    { refreshToken: refresh, clientId: client.client_id, clientSecret: client.client_secret },
    services,
  );
  const stored = tokenPayload(tokens, now, payload);
  const [ciphertext, nonce] = (services.encrypt ?? encryptPayload)(stored);
  const row = await db.saveMcpConnection(
    connection.id,
    {
      ciphertext,
      nonce,
      status: connection.status,
      accountHint: connection.account_hint || accountHint(stored),
      oauthState: connection.oauth_state,
    },
    now,
  );
  if (row === null) {
    throw new OAuthError("connection was deleted");
  }
  return row;
}
