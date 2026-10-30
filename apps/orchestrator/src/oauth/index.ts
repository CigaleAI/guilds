import { createHash, randomBytes } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
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
import { isPlainRecord } from "../db/json.js";
import { saveMcpConnection, type McpConnectionRow } from "../db/mcp.js";
import { bindQuery, type Queryable } from "../db/pg.js";
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

const OAUTH_PROVIDERS: Readonly<Record<string, OAuthProvider>> = {
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
};

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
  decrypt: (ciphertext: Buffer, nonce: Buffer) => Record<string, unknown>;
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

/** The account fields a token response may leave out, kept from the payload it replaces. */
const ACCOUNT_FIELDS: readonly string[] = ["user_id", "workspace_id", "email_domain"];

/** The instant a token response's `expires_in` ends, counted from `now`, or null when it names none. */
function expiryOf(tokens: Record<string, unknown>, now: Date): string | null {
  const expiresIn = tokens.expires_in;
  if (typeof expiresIn !== "number" || !Number.isInteger(expiresIn)) {
    return null;
  }
  return new Date(now.getTime() + expiresIn * 1000).toISOString();
}

/**
 * The payload a login stores from a token response received at `now`: the fields the response
 * leaves out are kept from `existing`, the payload it replaces.
 */
export function tokenPayload(
  tokens: Record<string, unknown>,
  now: Date,
  existing: Record<string, unknown> = {},
): Record<string, unknown> {
  const access = tokens.access_token;
  if (typeof access !== "string" || !access) {
    throw new OAuthError("token response is missing access_token");
  }
  let refresh = tokens.refresh_token;
  if (typeof refresh !== "string" || !refresh) {
    refresh = existing.refresh_token;
  }
  const payload: Record<string, unknown> = {
    access_token: access,
    refresh_token: typeof refresh === "string" ? refresh : null,
    token_type: tokens.token_type || "Bearer",
    expires_at: expiryOf(tokens, now) ?? existing.expires_at,
    ...Object.fromEntries(ACCOUNT_FIELDS.map((field) => [field, tokens[field] || existing[field]])),
    oauth_replaces: tokens.oauth_replaces === true || existing.oauth_replaces === true ? true : undefined,
  };
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== null && value !== undefined));
}

export function accountHint(payload: Record<string, unknown>): string {
  const domain = payload.email_domain;
  if (typeof domain === "string" && domain.trim()) {
    return domain.trim();
  }
  const workspace = payload.workspace_id;
  if (typeof workspace === "string" && workspace.trim()) {
    return workspace.trim();
  }
  return "";
}

/** The payload fields of a login that hold a secret, whatever its connector. */
export const TOKEN_FIELDS: readonly string[] = [
  "access_token",
  "refresh_token",
  "token",
  "evm_private_key",
  "solana_private_key",
  "alchemy_key",
  "opensea_key",
  "uniswap_key",
  "login",
  "secret_key",
];

export function tokenRedactions(payload: Record<string, unknown>, connectionId: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of TOKEN_FIELDS) {
    const value = payload[key];
    if (typeof value === "string" && value) {
      values[`mcp_${connectionId}_${key}`] = value;
    }
  }
  return values;
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
export function accessExpired(payload: Record<string, unknown>, now: Date, skewMs = 60_000): boolean {
  const raw = payload.expires_at;
  if (typeof raw !== "string" || !raw) {
    return false;
  }
  const expires = Date.parse(raw);
  if (Number.isNaN(expires)) {
    return false;
  }
  return now.getTime() + skewMs >= expires;
}

export function pendingOauthPayload(codeVerifier: string, redirectUri: string, replaces = false): Record<string, unknown> {
  return {
    oauth: {
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      replaces,
    },
  };
}

export function pendingReplaces(payload: Record<string, unknown>): boolean {
  if (payload.oauth_replaces === true) {
    return true;
  }
  const oauth = payload.oauth;
  return isPlainRecord(oauth) && oauth.replaces === true;
}

export function pendingOauth(payload: Record<string, unknown>): [string, string] {
  const oauth = payload.oauth;
  if (!isPlainRecord(oauth)) {
    throw new OAuthError("connection is missing oauth state");
  }
  const verifier = oauth.code_verifier;
  const redirectUri = oauth.redirect_uri;
  if (typeof verifier !== "string" || typeof redirectUri !== "string") {
    throw new OAuthError("connection is missing oauth state");
  }
  return [verifier, redirectUri];
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
function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const payload: unknown = JSON.parse(text);
    return isPlainRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

/** The first JSON object one of `urls` answers, tried in order. */
async function getJson(fetchFn: FetchFn, urls: string[]): Promise<Record<string, unknown>> {
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

/** What a login reads of a protected resource's metadata: the resource it names, and its first authorization server. */
type ProtectedResource = {
  resource: string;
  authorizationServer: string;
};

/** The protected resource `metadata` describes, the resource defaulting to `mcpUrl`. */
function protectedResourceOf(metadata: Record<string, unknown>, mcpUrl: string): ProtectedResource {
  const resource = metadata.resource;
  const servers = metadata.authorization_servers;
  const first: unknown = Array.isArray(servers) ? servers[0] : undefined;
  if (typeof first !== "string") {
    throw new OAuthError("protected resource metadata is missing authorization_servers");
  }
  return {
    resource: typeof resource === "string" && resource.trim() ? resource.trim() : mcpUrl,
    authorizationServer: first,
  };
}

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
  const resourceMeta = await getJson(fetchFn, resourceMetadataUrls(mcpUrl));
  const { resource, authorizationServer } = protectedResourceOf(resourceMeta, mcpUrl);
  const asMeta = await getJson(fetchFn, [authServerMetadataUrl(authorizationServer)]);
  const authorization = asMeta.authorization_endpoint;
  const token = asMeta.token_endpoint;
  if (typeof authorization !== "string" || typeof token !== "string") {
    throw new OAuthError("authorization server metadata is missing endpoints");
  }
  const registration = asMeta.registration_endpoint;
  const scopes = resourceMeta.scopes_supported ?? asMeta.scopes_supported ?? [];
  return {
    resource,
    authorization_endpoint: authorization.trim(),
    token_endpoint: token.trim(),
    registration_endpoint:
      typeof registration === "string" && registration.trim() ? registration.trim() : null,
    scopes: Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === "string") : [],
    access_type: null,
  };
}

/** What a dynamic client registration answers: the client's id, and a secret when the server issues one. */
const Registration = Type.Object({ client_id: Type.String(), client_secret: Type.Optional(Type.Unknown()) });

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
  if (!Value.Check(Registration, payload)) {
    throw new OAuthError("client registration did not return a client_id");
  }
  return {
    client_id: payload.client_id,
    client_secret: typeof payload.client_secret === "string" ? payload.client_secret : null,
    redirect_uris: [redirectUri],
  };
}

async function tokenError(response: Response, text: string): Promise<string | null> {
  const error = parseJsonObject(text)?.error;
  return typeof error === "string" ? error : null;
}

async function tokenRequest(
  discovery: OAuthDiscovery,
  fields: Record<string, string>,
  clientSecret: string | null | undefined,
  http: OAuthHttp,
): Promise<Record<string, unknown>> {
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
  if (!isPlainRecord(payload)) {
    throw new OAuthError("token response is not an object");
  }
  return payload;
}

export async function exchangeCode(
  discovery: OAuthDiscovery,
  grant: AuthorizationCodeGrant,
  http: OAuthHttp = {},
): Promise<Record<string, unknown>> {
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
): Promise<Record<string, unknown>> {
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
  const payload = services.decrypt(connection.ciphertext, connection.nonce);
  const refresh = payload.refresh_token;
  if (typeof refresh !== "string" || !refresh) {
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
