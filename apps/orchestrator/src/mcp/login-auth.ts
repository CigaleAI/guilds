import { instanceCredentials } from "../connectors/instance.js";
import { serverManifest, type LoadedConnector } from "../connectors/servers.js";
import { awaitingSettings } from "../connectors/login.js";
import { authFields } from "../connectors/manifest.js";
import type { Credentials } from "../connectors/types.js";
import { decryptPayload } from "../credentials/crypto.js";
import type { McpConnectionRow } from "../db/mcp.js";
import type { Manifest } from "../db/schema/index.js";
import { GithubInstallationGoneError } from "../github/index.js";
import { mintLoginToken, RepositoryAccessError, type RepositoryToken } from "../github/tokens.js";
import type { FetchFn } from "../net/http.js";
import { accessExpired, isGithubApp, OAuthReauthError, refreshConnection, TOKEN_FIELDS } from "../oauth/index.js";
import { McpDisconnectedError, McpError } from "./errors.js";
import type { McpSession } from "./session.js";
import { markDisconnected, type McpDatabase } from "./database.js";

/** What a login's session sends, and when that stops working; null when it does not expire while the session lives. */
export type SessionAuth = { headers: Record<string, string>; expiresAt: number | null };

/** The login an operation runs on. A refresh replaces `connection`, so later steps see the new token. */
export type Login = { connection: McpConnectionRow };

/**
 * The pool that keeps logins' sessions: the db/ functions it refreshes and disconnects logins
 * through, the fetch it mints GitHub App tokens with, its pooled session for a login, and how it
 * drops one.
 */
export type SessionPool = {
  readonly database: McpDatabase;
  readonly fetchFn: FetchFn;
  readonly session: (connection: McpConnectionRow, server: LoadedConnector) => Promise<McpSession>;
  drop(connectionId: string): void;
};

export function isOauth(server: LoadedConnector): boolean {
  return server.auth === "oauth";
}

function connectionPayload(connection: McpConnectionRow): Record<string, unknown> | null {
  try {
    return decryptPayload(connection.ciphertext, connection.nonce);
  } catch {
    return null;
  }
}

/** A login's credentials: every string in its decrypted payload, trimmed. */
export function connectionCredentials(connection: McpConnectionRow): Credentials {
  const credentials: Record<string, string> = {};
  for (const [name, value] of Object.entries(connectionPayload(connection) ?? {})) {
    if (typeof value === "string") {
      credentials[name] = value.trim();
    }
  }
  return credentials;
}

/**
 * The values a login's State is redacted against: the token fields runs redact, each credential
 * field its manifest does not mark `secret: false`, and the instance key serving a platform login.
 * The rest of its payload, such as the account a login names, is not secret.
 */
export function loginSecrets(connection: McpConnectionRow, manifest: Manifest): Record<string, string> {
  const credentials = connectionCredentials(connection);
  const fields = [...TOKEN_FIELDS, ...authFields(manifest).filter((field) => field.secret !== false).map((field) => field.name)];
  const secrets: Record<string, string> = {};
  for (const name of fields) {
    if (credentials[name]) {
      secrets[name] = credentials[name]!;
    }
  }
  if (connection.owner_scope === "platform" && manifest.auth.instance) {
    Object.assign(secrets, instanceCredentials(manifest));
  }
  return secrets;
}

/** What an endpoint session sends: an OAuth access token, else the login's `token`, else its first credential field. */
export function credentialToken(credentials: Credentials, manifest: Manifest): string {
  if (credentials.access_token) {
    return credentials.access_token;
  }
  if (credentials.token) {
    return credentials.token;
  }
  const first = authFields(manifest)[0]?.name;
  const value = first ? credentials[first] : undefined;
  return typeof value === "string" ? value : "";
}

/** What an endpoint session sends: the manifest's endpoint headers, and the token in its auth header. */
export function headersFor(token: string, manifest: Manifest): Record<string, string> {
  const fixed = { ...manifest.endpoint?.headers };
  if (!token) {
    return fixed;
  }
  const header = manifest.auth.header ?? { name: "Authorization", prefix: "Bearer " };
  return { ...fixed, [header.name]: `${header.prefix}${token}` };
}

export function authHeaders(connection: McpConnectionRow, server: LoadedConnector): Record<string, string> {
  const manifest = serverManifest(server);
  const credentials =
    connection.owner_scope === "platform" && manifest.auth.instance
      ? instanceCredentials(manifest)
      : connectionCredentials(connection);
  return headersFor(credentialToken(credentials, manifest), manifest);
}

/**
 * What a login's session sends. A GitHub App login sends an installation token for the
 * repositories it picked, which expires; any other login sends its stored credential.
 */
export async function resolveSessionAuth(
  pool: SessionPool,
  connection: McpConnectionRow,
  server: LoadedConnector,
): Promise<SessionAuth> {
  if (!isGithubApp(server)) {
    return { headers: authHeaders(connection, server), expiresAt: null };
  }
  const minted = await mintGithubAppToken(pool, connection);
  return { headers: headersFor(minted.token, serverManifest(server)), expiresAt: Date.parse(minted.expiresAt) };
}

/** A GitHub App login's installation token (`mintLoginToken`). GitHub refusing the installation disconnects the login. */
async function mintGithubAppToken(pool: SessionPool, connection: McpConnectionRow): Promise<RepositoryToken> {
  try {
    return await mintLoginToken(pool.database, connection, { fetch: pool.fetchFn });
  } catch (error) {
    if (error instanceof GithubInstallationGoneError) {
      return disconnectLogin(pool, connection);
    }
    throw error instanceof RepositoryAccessError ? new McpError(error.message, 422) : error;
  }
}

/** Disconnects the login and throws the disconnected error. */
async function disconnectLogin(pool: SessionPool, connection: McpConnectionRow): Promise<never> {
  await markDisconnected(pool.database, connection);
  pool.drop(connection.id);
  throw new McpDisconnectedError("connection is disconnected");
}

/**
 * The login with a fresh access token; a refresh that needs a new authorization disconnects it.
 * A login still waiting for its settings counts as signed in.
 */
export async function readyLogin(pool: SessionPool, connection: McpConnectionRow, server: LoadedConnector): Promise<McpConnectionRow> {
  if (connection.status !== "connected" && !awaitingSettings(connection)) {
    throw new McpDisconnectedError("connection is not connected");
  }
  const payload = connectionPayload(connection);
  if (payload === null || !accessExpired(payload, { now: new Date() })) {
    return connection;
  }
  return refreshLogin(pool, connection, server);
}

export async function refreshLogin(pool: SessionPool, connection: McpConnectionRow, server: LoadedConnector): Promise<McpConnectionRow> {
  let refreshed: McpConnectionRow;
  try {
    refreshed = await refreshConnection(pool.database, connection, server, { decrypt: decryptPayload });
  } catch (error) {
    if (error instanceof OAuthReauthError) {
      return disconnectLogin(pool, connection);
    }
    throw error;
  }
  pool.drop(connection.id);
  return refreshed;
}

/**
 * The login after its endpoint refused its credential with a 401. A GitHub App login gets a
 * new installation token with its next session; any other OAuth login refreshes its token.
 */
async function reauthorizeLogin(pool: SessionPool, connection: McpConnectionRow, server: LoadedConnector): Promise<McpConnectionRow> {
  if (isGithubApp(server)) {
    pool.drop(connection.id);
    return connection;
  }
  return refreshLogin(pool, connection, server);
}

export async function withAuthRetry<T>(
  pool: SessionPool,
  login: Login,
  server: LoadedConnector,
  action: (session: McpSession) => Promise<T>,
): Promise<T> {
  let session = await pool.session(login.connection, server);
  try {
    return await action(session);
  } catch (error) {
    if (!(error instanceof McpError) || error.status !== 401 || !isOauth(server)) {
      throw error;
    }
    login.connection = await reauthorizeLogin(pool, login.connection, server);
    session = await pool.session(login.connection, server);
    return await action(session);
  }
}
