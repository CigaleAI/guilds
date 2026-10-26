import { createHash, randomBytes } from "node:crypto";
import { proxyFetch, type FetchFn } from "../net/http.js";
import { jsonObj } from "../db/json.js";
import { encryptPayload } from "../credentials/crypto.js";
import { githubAppConfig } from "../github/index.js";
import {
  GOOGLE_CONNECTORS,
  integrationValues,
  type Integration,
  type IntegrationSources,
} from "../instance/integrations.js";
import { serverManifest } from "../connectors/load.js";
import type { Manifest } from "../connectors/manifest.js";
import type { McpConnectionLogin } from "../db/mcp.js";
import { connectorIntegration } from "../instance/connectors.js";

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
function manifestOauth(server: Record<string, unknown>): NonNullable<Manifest["auth"]["oauth"]> | null {
  return serverManifest(server)?.auth.oauth ?? null;
}

/**
 * The integration that holds a server's OAuth client: the shipped one its manifest's provider
 * names, or, for a configured client with no provider, the connector's own.
 */
function providerOf(server: Record<string, unknown>): OAuthProvider | null {
  const manifest = serverManifest(server);
  const oauth = manifest?.auth.oauth;
  if (!manifest || !oauth) {
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
export function isGithubApp(server: Record<string, unknown>): boolean {
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

export class OAuthUnsupportedError extends OAuthError {
  constructor(message: string) {
    super(message);
    this.name = "OAuthUnsupportedError";
  }
}

export function oauthStrategy(server: Record<string, unknown>): "none" | "dynamic" | "configured" {
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

export function startsBrowserOauth(server: Record<string, unknown>): boolean {
  return server.auth === "oauth";
}

export function oauthSetupState(
  server: Record<string, unknown>,
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

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      out[key] = item;
    }
  }
  return out as T;
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
  request: { protocol: string; headers: { host?: string | string[] | undefined } },
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
  options: { clientId: string; redirectUri: string; codeChallenge: string; state: string },
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

function configOf(server: Record<string, unknown>): Record<string, unknown> {
  const config = jsonObj(server.config);
  return config && typeof config === "object" && !Array.isArray(config)
    ? { ...(config as Record<string, unknown>) }
    : {};
}

export function storedClient(server: Record<string, unknown>): Record<string, unknown> | null {
  const client = configOf(server).oauth_client;
  if (client && typeof client === "object" && !Array.isArray(client) && typeof (client as { client_id?: unknown }).client_id === "string") {
    return client as Record<string, unknown>;
  }
  return null;
}

/** The OAuth client the manifest's provider integration holds, or null while that integration is off. */
export function providerClient(
  server: Record<string, unknown>,
  sources?: IntegrationSources,
): Record<string, unknown> | null {
  const provider = providerOf(server);
  if (provider === null) {
    return null;
  }
  const values = integrationValues(provider.integration, sources) as Record<string, string> | null;
  if (values === null) {
    return null;
  }
  return { client_id: values[provider.clientId], client_secret: values[provider.clientSecret] };
}

export function configuredClient(
  server: Record<string, unknown>,
  sources?: IntegrationSources,
): Record<string, unknown> | null {
  return storedClient(server) ?? providerClient(server, sources);
}

export function clientCoversRedirect(client: Record<string, unknown>, redirectUri: string): boolean {
  const uris = client.redirect_uris;
  return Array.isArray(uris) && uris.includes(redirectUri);
}

export function tokenPayload(
  tokens: Record<string, unknown>,
  options: { now: Date; existing?: Record<string, unknown> | null },
): Record<string, unknown> {
  const access = tokens.access_token;
  if (typeof access !== "string" || !access) {
    throw new OAuthError("token response is missing access_token");
  }
  const previous = options.existing ?? {};
  let refresh = tokens.refresh_token;
  if (typeof refresh !== "string" || !refresh) {
    refresh = previous.refresh_token;
  }
  let expiresAt = previous.expires_at;
  const expiresIn = tokens.expires_in;
  if (typeof expiresIn === "number" && Number.isInteger(expiresIn)) {
    expiresAt = new Date(options.now.getTime() + expiresIn * 1000).toISOString();
  }
  const payload: Record<string, unknown> = {
    access_token: access,
    refresh_token: typeof refresh === "string" ? refresh : null,
    token_type: tokens.token_type || "Bearer",
    expires_at: expiresAt,
    user_id: tokens.user_id || previous.user_id,
    workspace_id: tokens.workspace_id || previous.workspace_id,
    email_domain: tokens.email_domain || previous.email_domain,
    oauth_replaces: tokens.oauth_replaces === true || previous.oauth_replaces === true ? true : undefined,
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

export function accessExpired(
  payload: Record<string, unknown>,
  options: { now: Date; skewMs?: number },
): boolean {
  const raw = payload.expires_at;
  if (typeof raw !== "string" || !raw) {
    return false;
  }
  const expires = Date.parse(raw);
  if (Number.isNaN(expires)) {
    return false;
  }
  const skew = options.skewMs ?? 60_000;
  return options.now.getTime() + skew >= expires;
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
  return Boolean(oauth && typeof oauth === "object" && !Array.isArray(oauth) && (oauth as { replaces?: unknown }).replaces === true);
}

export function pendingOauth(payload: Record<string, unknown>): [string, string] {
  const oauth = payload.oauth;
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) {
    throw new OAuthError("connection is missing oauth state");
  }
  const verifier = (oauth as { code_verifier?: unknown }).code_verifier;
  const redirectUri = (oauth as { redirect_uri?: unknown }).redirect_uri;
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

async function getJson(fetchFn: FetchFn, urls: string[]): Promise<Record<string, unknown>> {
  let last = "discovery failed";
  for (const url of urls) {
    const response = await fetchFn(url, { method: "GET", headers: { Accept: "application/json" } });
    if (response.status >= 400) {
      last = `discovery failed: ${response.status}`;
      continue;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await response.text());
    } catch {
      last = "discovery returned a non-object";
      continue;
    }
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      return payload as Record<string, unknown>;
    }
    last = "discovery returned a non-object";
  }
  throw new OAuthError(last);
}

function scopedDiscovery(server: Record<string, unknown>, discovery: OAuthDiscovery): OAuthDiscovery {
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
  server: Record<string, unknown>,
  options: { client?: FetchFn | undefined; proxyUrl?: string | undefined } = {},
): Promise<OAuthDiscovery> {
  const url = configOf(server).url;
  if (typeof url === "string" && url.trim()) {
    return scopedDiscovery(server, await discover(url.trim(), options));
  }
  const provider = providerOf(server);
  if (provider === null || provider.discovery === null) {
    throw new OAuthError("mcp server is missing a url");
  }
  return scopedDiscovery(server, { ...provider.discovery });
}

export async function discover(
  mcpUrl: string,
  options: { client?: FetchFn | undefined; proxyUrl?: string | undefined } = {},
): Promise<OAuthDiscovery> {
  const fetchFn = options.client ?? proxyFetch(options.proxyUrl ?? "");
  const resourceMeta = await getJson(fetchFn, resourceMetadataUrls(mcpUrl));
  const resource = resourceMeta.resource;
  const resourceUrl =
    typeof resource === "string" && resource.trim() ? resource.trim() : mcpUrl;
  const servers = resourceMeta.authorization_servers;
  if (!Array.isArray(servers) || !servers.length || typeof servers[0] !== "string") {
    throw new OAuthError("protected resource metadata is missing authorization_servers");
  }
  const asMeta = await getJson(fetchFn, [authServerMetadataUrl(servers[0])]);
  const authorization = asMeta.authorization_endpoint;
  const token = asMeta.token_endpoint;
  if (typeof authorization !== "string" || typeof token !== "string") {
    throw new OAuthError("authorization server metadata is missing endpoints");
  }
  const registration = asMeta.registration_endpoint;
  const scopes = resourceMeta.scopes_supported ?? asMeta.scopes_supported ?? [];
  return {
    resource: resourceUrl,
    authorization_endpoint: authorization.trim(),
    token_endpoint: token.trim(),
    registration_endpoint:
      typeof registration === "string" && registration.trim() ? registration.trim() : null,
    scopes: Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === "string") : [],
    access_type: null,
  };
}

export async function registerClient(
  discovery: OAuthDiscovery,
  redirectUri: string,
  options: { client?: FetchFn | undefined; proxyUrl?: string | undefined } = {},
): Promise<Record<string, unknown>> {
  if (!discovery.registration_endpoint) {
    throw new OAuthError("authorization server does not support dynamic client registration");
  }
  const fetchFn = options.client ?? proxyFetch(options.proxyUrl ?? "");
  const response = await fetchFn(discovery.registration_endpoint, {
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
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof (payload as { client_id?: unknown }).client_id !== "string") {
    throw new OAuthError("client registration did not return a client_id");
  }
  const body = payload as Record<string, unknown>;
  return {
    client_id: body.client_id,
    client_secret: typeof body.client_secret === "string" ? body.client_secret : null,
    redirect_uris: [redirectUri],
  };
}

async function tokenError(response: Response, text: string): Promise<string | null> {
  try {
    const payload: unknown = text ? JSON.parse(text) : {};
    if (payload && typeof payload === "object" && !Array.isArray(payload) && typeof (payload as { error?: unknown }).error === "string") {
      return (payload as { error: string }).error;
    }
  } catch {
    return null;
  }
  return null;
}

async function tokenRequest(
  discovery: OAuthDiscovery,
  fields: Record<string, string>,
  options: { clientSecret?: string | null | undefined; client?: FetchFn | undefined; proxyUrl?: string | undefined },
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams(fields);
  if (options.clientSecret) {
    params.set("client_secret", options.clientSecret);
  }
  const fetchFn = options.client ?? proxyFetch(options.proxyUrl ?? "");
  const response = await fetchFn(discovery.token_endpoint, {
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
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new OAuthError("token response is not an object");
  }
  return payload as Record<string, unknown>;
}

export async function exchangeCode(
  discovery: OAuthDiscovery,
  options: {
    code: string;
    codeVerifier: string;
    clientId: string;
    clientSecret?: string | null | undefined;
    redirectUri: string;
    client?: FetchFn | undefined;
    proxyUrl?: string | undefined;
  },
): Promise<Record<string, unknown>> {
  return tokenRequest(
    discovery,
    {
      grant_type: "authorization_code",
      code: options.code,
      client_id: options.clientId,
      redirect_uri: options.redirectUri,
      code_verifier: options.codeVerifier,
      ...(discovery.resource ? { resource: discovery.resource } : {}),
    },
    omitUndefined({ clientSecret: options.clientSecret, client: options.client, proxyUrl: options.proxyUrl }),
  );
}

export async function refreshTokens(
  discovery: OAuthDiscovery,
  options: {
    refreshToken: string;
    clientId: string;
    clientSecret?: string | null | undefined;
    client?: FetchFn | undefined;
    proxyUrl?: string | undefined;
  },
): Promise<Record<string, unknown>> {
  return tokenRequest(
    discovery,
    {
      grant_type: "refresh_token",
      refresh_token: options.refreshToken,
      client_id: options.clientId,
      ...(discovery.resource ? { resource: discovery.resource } : {}),
    },
    omitUndefined({ clientSecret: options.clientSecret, client: options.client, proxyUrl: options.proxyUrl }),
  );
}

type OauthDb = {
  updateMcpServerConfig?(
    serverId: string,
    config: unknown,
    now: Date,
  ): Promise<Record<string, unknown> | null>;
  saveMcpConnection?(
    connectionId: string,
    login: McpConnectionLogin,
    now: Date,
  ): Promise<Record<string, unknown> | null>;
};

export async function ensureClient(
  db: OauthDb,
  server: Record<string, unknown>,
  redirectUri: string,
  options: { client?: FetchFn | undefined; proxyUrl?: string | undefined; sources?: IntegrationSources | undefined } = {},
): Promise<[OAuthDiscovery, Record<string, unknown>]> {
  const strategy = oauthStrategy(server);
  if (strategy === "none" || server.auth !== "oauth") {
    throw new OAuthUnsupportedError("connector is not oauth");
  }
  const discovery = await serverDiscovery(server, omitUndefined({ client: options.client, proxyUrl: options.proxyUrl }));
  const current = storedClient(server);
  if (current !== null && clientCoversRedirect(current, redirectUri)) {
    return [discovery, current];
  }
  const provided = providerClient(server, options.sources);
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
  const registered = await registerClient(discovery, redirectUri, options);
  const config = { ...configOf(server), oauth_client: registered };
  if (!db.updateMcpServerConfig) {
    throw new OAuthError("mcp db cannot save server config");
  }
  await db.updateMcpServerConfig(String(server.id), config, new Date());
  return [discovery, registered];
}

export async function refreshConnection(
  db: OauthDb,
  connection: Record<string, unknown>,
  server: Record<string, unknown>,
  options: {
    client?: FetchFn | undefined;
    proxyUrl?: string | undefined;
    now?: Date;
    decrypt: (ciphertext: Buffer, nonce: Buffer) => Record<string, unknown>;
    encrypt?: typeof encryptPayload;
  },
): Promise<Record<string, unknown>> {
  const now = options.now ?? new Date();
  const payload = options.decrypt(connection.ciphertext as Buffer, connection.nonce as Buffer);
  const refresh = payload.refresh_token;
  if (typeof refresh !== "string" || !refresh) {
    throw new OAuthReauthError("connection has no refresh token");
  }
  const discovery = await serverDiscovery(server, options);
  const client = configuredClient(server);
  if (client === null) {
    throw new OAuthError("mcp server is missing an oauth client");
  }
  const tokens = await refreshTokens(discovery, omitUndefined({
    refreshToken: refresh,
    clientId: String(client.client_id),
    clientSecret: typeof client.client_secret === "string" ? client.client_secret : null,
    client: options.client,
    proxyUrl: options.proxyUrl,
  }));
  const stored = tokenPayload(tokens, { now, existing: payload });
  const [ciphertext, nonce] = (options.encrypt ?? encryptPayload)(stored);
  if (!db.saveMcpConnection) {
    throw new OAuthError("mcp db cannot save connections");
  }
  const row = await db.saveMcpConnection(
    String(connection.id),
    {
      ciphertext,
      nonce,
      status: String(connection.status || "connected"),
      accountHint: String(connection.account_hint || accountHint(stored)),
      oauthState: typeof connection.oauth_state === "string" ? connection.oauth_state : null,
    },
    now,
  );
  if (row === null) {
    throw new OAuthError("connection was deleted");
  }
  return row;
}

export { githubInstallationPickerHtml, oauthCallbackHtml } from "./html.js";
