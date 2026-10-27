import { decryptPayload } from "../credentials/crypto.js";
import { insertBindingIfAbsent } from "../db/bindings.js";
import {
  countConnectorCalls,
  recordConnectorCall,
  updateMcpServerConfig,
} from "../db/connectors.js";
import { replaceMcpTools, saveMcpConnection } from "../db/mcp.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import { jsonObj } from "../db/json.js";
import type { Manifest } from "../db/schema/index.js";
import { newId } from "../lib/ids.js";
import { assertPublicHost, EndpointError, type HostLookup } from "../net/endpoints.js";
import { proxyFetch, type FetchFn } from "../net/http.js";
import { GithubInstallationGoneError } from "../github/index.js";
import {
  mintLoginToken,
  RepositoryAccessError,
  TOKEN_REFRESH_MS,
  githubRepositoryRecorder,
  type RepositoryToken,
} from "../github/tokens.js";
import { accessExpired, isGithubApp, OAuthReauthError, refreshConnection, TOKEN_FIELDS } from "../oauth/index.js";
import { accessDatabase, agentMcpConnection, type AccessDatabase } from "../access/runtime.js";
import { installedConnectors } from "../connectors/index.js";
import type { ConnectorRegistry } from "../connectors/registry.js";
import {
  ConnectorError,
  isConnectorError,
  type Adapter,
  type ConnectorContext,
  type ConnectorTool,
  type Credentials,
  type LookupOption,
  type RemoteInfo,
  type RemoteSession,
} from "../connectors/types.js";
import { authFields } from "../connectors/manifest.js";
import { redact } from "../secrets/index.js";
import type { OrgPolicy } from "../policy/index.js";
import { utcMonth } from "../usage/index.js";

import { namespacedName } from "./names.js";
import { manifestExcludes, overriddenTool, serverManifest, toolStartsOff } from "../connectors/load.js";
import { awaitingSettings, connectionSettings } from "../connectors/login.js";
import { instanceCredentials } from "../connectors/instance.js";

export { awaitingSettings, connectionSettings } from "../connectors/login.js";
import { writeLog } from "../observability/log.js";
import { llmToolParameters, omitEmptyOptionalStrings } from "../toolbox/schema.js";

export { namespacedName } from "./names.js";
export { isReadOnlyRemote } from "./policy.js";

export const PROTOCOL_VERSION = "2025-03-26";
export const TOOLS_TTL_MS = 10 * 60 * 1000;
export const LIST_TOOLS_TIMEOUT_MS = 15_000;
export const CALL_TOOL_TIMEOUT_MS = 90_000;
export const LIST_TOOLS_MAX_BYTES = 1_000_000;
export const LIST_TOOLS_MAX = 200;
/** Run start waits at most this long for every connector's State hook before running without them. */
export const STATE_TIMEOUT_MS = 5_000;
/** A State hook's value is replaced with `unavailable` above this many serialised bytes. */
export const STATE_MAX_BYTES = 32_000;

export class McpError extends Error {
  status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "McpError";
    this.status = status;
  }
}

/**
 * The server no longer knows the session a request carried: a 404, as the protocol says, or a 400
 * with no JSON-RPC body, as some servers answer. It ran nothing; a new session may retry.
 */
export class McpSessionGoneError extends McpError {
  constructor(status: number) {
    super(`mcp ${status}: the server no longer knows the session`, status);
    this.name = "McpSessionGoneError";
  }
}

export class McpDisconnectedError extends McpError {
  constructor(message: string) {
    super(message);
    this.name = "McpDisconnectedError";
  }
}

export class ListedTool {
  constructor(
    public remote_name: string,
    public namespaced_name: string,
    public description: string,
    public input_schema: Record<string, unknown>,
    /** The listing's `readOnlyHint`, null when it gave none. */
    public read_only_hint: boolean | null = null,
    /** The listing's `destructiveHint`, null when it gave none. */
    public destructive_hint: boolean | null = null,
  ) {}
}

function hintOf(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function mcpSchema(tool: ListedTool): Record<string, unknown> {
  let parameters: unknown = tool.input_schema && Object.keys(tool.input_schema).length
    ? tool.input_schema
    : { type: "object" };
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    parameters = { type: "object" };
  }
  return {
    type: "function",
    function: {
      name: tool.namespaced_name,
      description: tool.description,
      parameters: llmToolParameters(parameters as Record<string, unknown>),
    },
  };
}

function schemaObj(value: unknown): Record<string, unknown> {
  let loaded = value;
  if (typeof loaded === "string") {
    try {
      loaded = JSON.parse(loaded);
    } catch {
      return { type: "object" };
    }
  }
  return loaded && typeof loaded === "object" && !Array.isArray(loaded)
    ? (loaded as Record<string, unknown>)
    : { type: "object" };
}

function remoteSchema(tool: Record<string, unknown>): Record<string, unknown> {
  const schema = pythonOr(tool.inputSchema, tool.input_schema, { type: "object" });
  return schemaObj(schema);
}

function pythonOr(...values: unknown[]): unknown {
  for (const value of values) {
    if (value === null || value === undefined || value === false || value === 0 || value === "") {
      continue;
    }
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0) {
      continue;
    }
    return value;
  }
  return values[values.length - 1];
}

export function fromRemote(slug: string, tool: Record<string, unknown>): ListedTool {
  const remoteName = tool.name;
  if (typeof remoteName !== "string" || !remoteName.trim()) {
    throw new McpError("mcp tool is missing a name");
  }
  const remote = remoteName.trim();
  const description = tool.description;
  return new ListedTool(
    remote,
    namespacedName(slug, remote),
    typeof description === "string" ? description : "",
    remoteSchema(tool),
  );
}

export function listedFromRows(rows: Array<Record<string, unknown>>): ListedTool[] {
  return rows.map(
    (row) =>
      new ListedTool(
        String(row.remote_name),
        String(row.namespaced_name),
        String(row.description || ""),
        schemaObj(row.input_schema),
        hintOf(row.read_only_hint),
        hintOf(row.destructive_hint),
      ),
  );
}

function latestListedAt(rows: Array<Record<string, unknown>>): number | null {
  let latest = 0;
  for (const row of rows) {
    const value = row.listed_at;
    let ms = Number.NaN;
    if (value instanceof Date) {
      ms = value.getTime();
    } else if (typeof value === "number") {
      ms = value;
    } else if (typeof value === "string" && value) {
      ms = Date.parse(value);
    }
    if (Number.isFinite(ms) && ms > latest) {
      latest = ms;
    }
  }
  return latest > 0 ? latest : null;
}

function parseBody(contentType: string, text: string): unknown {
  if (contentType.includes("text/event-stream")) {
    let data: unknown = null;
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        const raw = line.slice(5).trim();
        if (raw) {
          data = JSON.parse(raw);
        }
      }
    }
    return data;
  }
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

/** The body as JSON-RPC, or an `McpError` with the status and the start of the body when it is not JSON. */
function parsedPayload(contentType: string, response: { status: number; body: string }): unknown {
  try {
    return parseBody(contentType, response.body);
  } catch {
    const said = response.body.trim().slice(0, 200);
    throw new McpError(`mcp ${response.status}: ${said || "a body that is not JSON"}`, response.status);
  }
}

export function rpcPayload(response: { status: number; headers?: Headers | Record<string, string>; body: string }): unknown {
  const headerValue =
    response.headers instanceof Headers
      ? response.headers.get("content-type") ?? ""
      : String((response.headers ?? {})["content-type"] ?? "");
  const payload = parsedPayload(headerValue, response);
  if (response.status < 400) {
    return payload;
  }
  if (
    payload
    && typeof payload === "object"
    && !Array.isArray(payload)
    && "result" in payload
    && !(payload as { error?: unknown }).error
  ) {
    return payload;
  }
  throw new McpError(`mcp ${response.status}`, response.status);
}

function callText(result: unknown): string {
  if (result === null || result === undefined) {
    return "";
  }
  if (typeof result === "string") {
    return result;
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return JSON.stringify(result);
  }
  const body = result as Record<string, unknown>;
  const content = body.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item && typeof item === "object" && !Array.isArray(item) && typeof (item as { text?: unknown }).text === "string") {
        parts.push((item as { text: string }).text);
      } else if (typeof item === "string") {
        parts.push(item);
      }
    }
    if (parts.length) {
      return parts.join("\n");
    }
  }
  return JSON.stringify(result);
}

function serverUrl(server: Record<string, unknown>): string {
  const config = jsonObj(server.config);
  const url = config && typeof config === "object" && !Array.isArray(config)
    ? (config as { url?: unknown }).url
    : undefined;
  if (typeof url !== "string" || !url.trim()) {
    throw new McpError("mcp server is missing a url");
  }
  return url.trim();
}

function connectionPayload(connection: Record<string, unknown>): Record<string, unknown> | null {
  try {
    return decryptPayload(connection.ciphertext as Buffer, connection.nonce as Buffer);
  } catch {
    return null;
  }
}

/** A login's credentials: every string in its decrypted payload, trimmed. */
export function connectionCredentials(connection: Record<string, unknown>): Credentials {
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
function loginSecrets(connection: Record<string, unknown>, manifest: Manifest | null): Record<string, string> {
  const credentials = connectionCredentials(connection);
  const fields = [...TOKEN_FIELDS, ...(manifest ? authFields(manifest) : []).filter((field) => field.secret !== false).map((field) => field.name)];
  const secrets: Record<string, string> = {};
  for (const name of fields) {
    if (credentials[name]) {
      secrets[name] = credentials[name]!;
    }
  }
  if (connection.owner_scope === "platform" && manifest?.auth.instance) {
    Object.assign(secrets, instanceCredentials(manifest));
  }
  return secrets;
}

/** What an endpoint session sends: an OAuth access token, else the login's `token`, else its first credential field. */
function credentialToken(credentials: Credentials, manifest: Manifest | null): string {
  if (credentials.access_token) {
    return credentials.access_token;
  }
  if (credentials.token) {
    return credentials.token;
  }
  const first = manifest ? authFields(manifest)[0]?.name : undefined;
  const value = first ? credentials[first] : undefined;
  return typeof value === "string" ? value : "";
}

/** What an endpoint session sends: the manifest's endpoint headers, and the token in its auth header. */
function headersFor(token: string, manifest: Manifest | null): Record<string, string> {
  const fixed = { ...manifest?.endpoint?.headers };
  if (!token) {
    return fixed;
  }
  const header = manifest?.auth.header ?? { name: "Authorization", prefix: "Bearer " };
  return { ...fixed, [header.name]: `${header.prefix}${token}` };
}

export function authHeaders(
  connection: Record<string, unknown>,
  server: Record<string, unknown>,
  connectors: ConnectorRegistry = installedConnectors(),
): Record<string, string> {
  const manifest = connectors.forServer(server)?.manifest ?? serverManifest(server);
  const credentials =
    connection.owner_scope === "platform" && manifest?.auth.instance
      ? instanceCredentials(manifest)
      : connectionCredentials(connection);
  return headersFor(credentialToken(credentials, manifest), manifest);
}

/** A tool from a remote `tools/list`, with its annotations, null when absent. */
export function remoteConnectorTool(tool: Record<string, unknown>): ConnectorTool {
  const listed = fromRemote("", tool);
  const annotations = jsonObj(tool.annotations);
  const hint = (name: string): boolean | null => {
    const value = annotations && typeof annotations === "object" && !Array.isArray(annotations)
      ? (annotations as Record<string, unknown>)[name]
      : undefined;
    return typeof value === "boolean" ? value : null;
  };
  return {
    name: listed.remote_name,
    description: listed.description,
    input_schema: listed.input_schema,
    read_only_hint: hint("readOnlyHint"),
    destructive_hint: hint("destructiveHint"),
  };
}

/**
 * A fetch that refuses an endpoint whose host resolves to a private or local address, checked
 * before each request so a name that moves inward is caught.
 */
export function publicOnly(fetchFn: FetchFn, resolve?: HostLookup): FetchFn {
  return async (url, init) => {
    try {
      await assertPublicHost(new URL(String(url)).hostname, resolve);
    } catch (error) {
      if (error instanceof EndpointError) {
        throw new McpError(error.message, 403);
      }
      throw error;
    }
    return fetchFn(url, init);
  };
}

/** Whether a reply to a request that carried a session says the server no longer knows it. */
function sessionGone(status: number, contentType: string, body: string): boolean {
  if (status === 404) {
    return true;
  }
  if (status !== 400) {
    return false;
  }
  try {
    const payload = parseBody(contentType, body);
    return !payload || typeof payload !== "object" || !("jsonrpc" in payload);
  } catch {
    return true;
  }
}

export class McpSession {
  url: string;
  headers: Record<string, string>;
  private rpcId = 0;
  private sessionId: string | null = null;
  private initialized = false;
  private fetchFn: FetchFn;

  constructor(url: string, headers: Record<string, string> = {}, fetchFn: FetchFn = proxyFetch("", CALL_TOOL_TIMEOUT_MS)) {
    this.url = url;
    this.headers = headers;
    this.fetchFn = fetchFn;
  }

  /** Starts the session; answers the server's name and instructions from its `initialize` result. */
  async initialize(): Promise<RemoteInfo> {
    const result = await this.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "guilds", version: "0.1" },
    });
    await this.notify("notifications/initialized");
    this.initialized = true;
    const body = result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : {};
    const info = body.serverInfo && typeof body.serverInfo === "object" ? (body.serverInfo as Record<string, unknown>) : {};
    return {
      name: typeof info.title === "string" && info.title.trim() ? info.title.trim() : typeof info.name === "string" ? info.name.trim() : "",
      instructions: typeof body.instructions === "string" ? body.instructions.trim() : "",
    };
  }

  /** Runs `work` on a started session. A session the server no longer knows starts over, once. */
  private async onSession<T>(work: () => Promise<T>): Promise<T> {
    try {
      if (!this.initialized) {
        await this.initialize();
      }
      return await work();
    } catch (error) {
      if (!(error instanceof McpSessionGoneError)) {
        throw error;
      }
      this.sessionId = null;
      this.initialized = false;
      await this.initialize();
      return work();
    }
  }

  async listTools(): Promise<Array<Record<string, unknown>>> {
    const result = await this.onSession(() =>
      this.rpc("tools/list", {}, {
        timeoutMs: LIST_TOOLS_TIMEOUT_MS,
        maxBytes: LIST_TOOLS_MAX_BYTES,
      }),
    );
    const tools = result && typeof result === "object" && !Array.isArray(result)
      ? (result as { tools?: unknown }).tools
      : undefined;
    if (!Array.isArray(tools)) {
      return [];
    }
    const listed = tools.filter((tool): tool is Record<string, unknown> => Boolean(tool) && typeof tool === "object" && !Array.isArray(tool));
    if (listed.length > LIST_TOOLS_MAX) {
      throw new McpError(`mcp tools/list returned more than ${LIST_TOOLS_MAX} tools`);
    }
    return listed;
  }

  async callToolResult(name: string, arguments_: Record<string, unknown>): Promise<unknown> {
    return this.onSession(() => this.rpc("tools/call", { name, arguments: arguments_ }));
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<string> {
    return callText(await this.callToolResult(name, arguments_));
  }

  async aclose(): Promise<void> {
    return undefined;
  }

  private async notify(method: string): Promise<void> {
    await this.post({ jsonrpc: "2.0", method });
  }

  private async rpc(
    method: string,
    params: Record<string, unknown>,
    options: { timeoutMs?: number; maxBytes?: number } = {},
  ): Promise<unknown> {
    this.rpcId += 1;
    const payload = await this.post({ jsonrpc: "2.0", id: this.rpcId, method, params }, options);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new McpError(`${method} returned a non-object`);
    }
    if ((payload as { error?: unknown }).error) {
      throw new McpError(String((payload as { error: unknown }).error));
    }
    return (payload as { result?: unknown }).result;
  }

  private async post(
    body: Record<string, unknown>,
    options: { timeoutMs?: number; maxBytes?: number } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.headers,
    };
    const carried = this.sessionId;
    if (carried) {
      headers["Mcp-Session-Id"] = carried;
    }
    const controller = options.timeoutMs ? new AbortController() : null;
    const timer = controller && options.timeoutMs
      ? setTimeout(() => controller.abort(), options.timeoutMs)
      : null;
    let response: Response;
    try {
      response = await this.fetchFn(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (error) {
      if (controller?.signal.aborted) {
        throw new McpError("mcp tools/list timed out");
      }
      throw error;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
    const session = response.headers.get("mcp-session-id");
    if (session) {
      this.sessionId = session;
    }
    const text = await response.text();
    if (options.maxBytes !== undefined && Buffer.byteLength(text, "utf8") > options.maxBytes) {
      throw new McpError("mcp tools/list response exceeded byte limit");
    }
    if (carried && sessionGone(response.status, response.headers.get("content-type") ?? "", text)) {
      throw new McpSessionGoneError(response.status);
    }
    return rpcPayload({
      status: response.status,
      headers: response.headers,
      body: text,
    });
  }
}

/** The db/ functions the pool lists, meters and refreshes logins through, on `db`. */
export function mcpDatabase(db: Queryable) {
  return {
    ...accessDatabase(db),
    ...githubRepositoryRecorder(db),
    countConnectorCalls: bindQuery(db, countConnectorCalls),
    recordConnectorCall: bindQuery(db, recordConnectorCall),
    replaceMcpTools: bindQuery(db, replaceMcpTools),
    insertBindingIfAbsent: bindQuery(db, insertBindingIfAbsent),
    saveMcpConnection: bindQuery(db, saveMcpConnection),
    updateMcpServerConfig: bindQuery(db, updateMcpServerConfig),
  };
}

export type McpDatabase = ReturnType<typeof mcpDatabase>;

/** What refreshing and disconnecting a login needs. */
type LoginDb = Pick<McpDatabase, "saveMcpConnection" | "updateMcpServerConfig" | "recordGithubRepository">;

/** What a login's session sends, and when that stops working; null when it does not expire while the session lives. */
type SessionAuth = { headers: Record<string, string>; expiresAt: number | null };

/** A pooled session and when the credential it sends expires. */
type PooledSession = { session: McpSession; expiresAt: number | null };

export async function markDisconnected(db: Pick<McpDatabase, "saveMcpConnection">, connection: Record<string, unknown>): Promise<void> {
  await db.saveMcpConnection(
    String(connection.id),
    {
      ciphertext: connection.ciphertext as Buffer,
      nonce: connection.nonce as Buffer,
      status: "disconnected",
      accountHint: String(connection.account_hint ?? ""),
      oauthState: null,
    },
    new Date(),
  );
}

/** A server's connector: its manifest and adapter, or the plain MCP client for a server created by hand. */
type Resolved = {
  manifest: Manifest | null;
  adapter: Adapter;
  endpoint: boolean;
};

/** The login an operation runs on. A refresh replaces `connection`, so later steps see the new token. */
type Login = { connection: Record<string, unknown> };

function translateConnectorError(error: unknown): unknown {
  return isConnectorError(error) ? new McpError(error.message, error.status) : error;
}

function isOauth(server: Record<string, unknown>): boolean {
  return server.auth === "oauth";
}

const NO_REMOTE: RemoteSession = {
  initialize: () => Promise.reject(new ConnectorError("connector has no endpoint")),
  list: () => Promise.reject(new ConnectorError("connector has no endpoint")),
  call: () => Promise.reject(new ConnectorError("connector has no endpoint")),
};

async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export type StateDatabase = AccessDatabase & LoginDb;

/** Studio's stand-in for `McpPool.state`: each key the agent's connectors fill, without calling them. */
export async function previewConnectorState(
  db: AccessDatabase,
  agent: Record<string, unknown>,
  connectors: ConnectorRegistry = installedConnectors(),
): Promise<Record<string, unknown>> {
  const state: Record<string, unknown> = {};
  for (const entry of connectors.entries()) {
    if (entry.manifest.state && (await agentMcpConnection(db, agent, entry.manifest.slug))) {
      state[entry.manifest.state.key] = { unavailable: "fetched live at run start" };
    }
  }
  return state;
}

export class McpPool {
  private sessions = new Map<string, PooledSession>();
  private syncedAt = new Map<string, number>();
  private toolsTtlMs: number;
  proxyUrl: string;
  fetchFn: FetchFn;
  /** The connectors this pool dispatches to; the box's installed ones unless set. */
  connectors: ConnectorRegistry | null = null;
  /** How an endpoint's session reaches it: through the proxy, refusing private addresses. */
  endpointFetch: FetchFn;
  /** The organisation policy that caps calls on platform logins; none caps nothing. */
  policy: OrgPolicy | null = null;

  /** The login's pooled session, reopened once the credential it sends is within `TOKEN_REFRESH_MS` of expiry. */
  session: (
    connection: Record<string, unknown>,
    server: Record<string, unknown>,
    db: LoginDb,
  ) => Promise<McpSession>;

  constructor(toolsTtlMs = TOOLS_TTL_MS, proxyUrl = "") {
    this.toolsTtlMs = toolsTtlMs;
    this.proxyUrl = proxyUrl;
    this.fetchFn = proxyFetch(this.proxyUrl);
    this.endpointFetch = publicOnly(proxyFetch(this.proxyUrl, CALL_TOOL_TIMEOUT_MS));
    this.session = async (connection, server, db) => {
      const connectionId = String(connection.id);
      const current = this.sessions.get(connectionId);
      if (current && (current.expiresAt === null || current.expiresAt - Date.now() > TOKEN_REFRESH_MS)) {
        return current.session;
      }
      const auth = await this.sessionAuth(db, connection, server);
      const opened = new McpSession(serverUrl(server), auth.headers, this.endpointFetch);
      this.sessions.set(connectionId, { session: opened, expiresAt: auth.expiresAt });
      return opened;
    };
  }

  private get registry(): ConnectorRegistry {
    return this.connectors ?? installedConnectors();
  }

  /**
   * What a login's session sends. A GitHub App login sends an installation token for the
   * repositories it picked, which expires; any other login sends its stored credential.
   */
  private async sessionAuth(
    db: LoginDb,
    connection: Record<string, unknown>,
    server: Record<string, unknown>,
  ): Promise<SessionAuth> {
    if (!isGithubApp(server)) {
      return { headers: authHeaders(connection, server, this.registry), expiresAt: null };
    }
    const minted = await this.mintGithubAppToken(db, connection);
    const manifest = this.resolve(server).manifest ?? serverManifest(server);
    return { headers: headersFor(minted.token, manifest), expiresAt: Date.parse(minted.expiresAt) };
  }

  /** A GitHub App login's installation token (`mintLoginToken`). GitHub refusing the installation disconnects the login. */
  private async mintGithubAppToken(db: LoginDb, connection: Record<string, unknown>): Promise<RepositoryToken> {
    try {
      return await mintLoginToken(db, connection, { fetch: this.fetchFn });
    } catch (error) {
      if (error instanceof GithubInstallationGoneError) {
        return this.disconnect(db, connection);
      }
      throw error instanceof RepositoryAccessError ? new McpError(error.message, 422) : error;
    }
  }

  drop(connectionId: string): void {
    this.sessions.delete(connectionId);
  }

  forget(connectionId: string): void {
    this.drop(connectionId);
    this.syncedAt.delete(connectionId);
  }

  /** Forgets when every login last listed its tools, so each lists again on its next use. */
  forgetListings(): void {
    this.syncedAt.clear();
  }

  private resolve(server: Record<string, unknown>): Resolved {
    const entry = this.registry.forServer(server);
    if (entry === null) {
      return { manifest: null, adapter: {}, endpoint: true };
    }
    return { manifest: entry.manifest, adapter: entry.adapter, endpoint: Boolean(entry.manifest.endpoint) };
  }

  private catalogFresh(
    connectionId: string,
    now: Date,
    stored: Array<Record<string, unknown>> = [],
  ): boolean {
    const synced = this.syncedAt.get(connectionId);
    if (synced !== undefined && now.getTime() - synced < this.toolsTtlMs) {
      return true;
    }
    const listedAt = latestListedAt(stored);
    if (listedAt !== null && now.getTime() - listedAt < this.toolsTtlMs) {
      this.syncedAt.set(connectionId, listedAt);
      return true;
    }
    return false;
  }

  private async persistTools(
    db: McpDatabase,
    connection: Record<string, unknown>,
    server: Record<string, unknown>,
    listed: ListedTool[],
    now: Date,
  ): Promise<void> {
    await db.replaceMcpTools(String(connection.id), listed, now);
    await this.writeDefaultOff(db, connection, server, listed, now);
    this.syncedAt.set(String(connection.id), now.getTime());
  }

  /** Writes an Off overlay at the login's owner for each listed tool that starts Off, unless one is there. */
  private async writeDefaultOff(
    db: McpDatabase,
    connection: Record<string, unknown>,
    server: Record<string, unknown>,
    listed: ListedTool[],
    now: Date,
  ): Promise<void> {
    const ownerScope = connection.owner_scope;
    if (typeof ownerScope !== "string" || !ownerScope) {
      return;
    }
    const ownerId = connection.owner_id;
    if (ownerScope !== "platform" && typeof ownerId !== "string") {
      return;
    }
    const off = new Map<string, ListedTool>();
    for (const tool of listed) {
      if (toolStartsOff(server, tool.remote_name, { destructiveHint: tool.destructive_hint })) {
        off.set(tool.namespaced_name, tool);
      }
    }
    for (const tool of off.values()) {
      await db.insertBindingIfAbsent(
        {
          bindingId: newId("bind"),
          catalogKind: "mcp_tool",
          catalogId: tool.namespaced_name,
          scope: ownerScope,
          scopeId: ownerScope === "platform" ? null : (ownerId as string),
          enabled: false,
        },
        now,
      );
    }
  }

  /** Disconnects the login and throws the disconnected error. */
  private async disconnect(db: LoginDb, connection: Record<string, unknown>): Promise<never> {
    await markDisconnected(db, connection);
    this.drop(String(connection.id));
    throw new McpDisconnectedError("connection is disconnected");
  }

  /**
   * The login with a fresh access token; a refresh that needs a new authorization disconnects it.
   * A login still waiting for its settings counts as signed in.
   */
  private async ready(
    db: LoginDb,
    connection: Record<string, unknown>,
    server: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (connection.status !== "connected" && !awaitingSettings(connection)) {
      throw new McpDisconnectedError("connection is not connected");
    }
    const payload = connectionPayload(connection);
    if (payload === null || !accessExpired(payload, { now: new Date() })) {
      return connection;
    }
    return this.refresh(db, connection, server);
  }

  private async refresh(
    db: LoginDb,
    connection: Record<string, unknown>,
    server: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let refreshed: Record<string, unknown>;
    try {
      refreshed = await refreshConnection(db, connection, server, { decrypt: decryptPayload });
    } catch (error) {
      if (error instanceof OAuthReauthError) {
        return this.disconnect(db, connection);
      }
      throw error;
    }
    this.drop(String(connection.id));
    return refreshed;
  }

  /**
   * The login after its endpoint refused its credential with a 401. A GitHub App login gets a
   * new installation token with its next session; any other OAuth login refreshes its token.
   */
  private async reauthorize(
    db: LoginDb,
    connection: Record<string, unknown>,
    server: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (isGithubApp(server)) {
      this.drop(String(connection.id));
      return connection;
    }
    return this.refresh(db, connection, server);
  }

  private async withAuthRetry<T>(
    db: LoginDb,
    login: Login,
    server: Record<string, unknown>,
    action: (session: McpSession) => Promise<T>,
  ): Promise<T> {
    let session = await this.session(login.connection, server, db);
    try {
      return await action(session);
    } catch (error) {
      if (!(error instanceof McpError) || error.status !== 401 || !isOauth(server)) {
        throw error;
      }
      login.connection = await this.reauthorize(db, login.connection, server);
      session = await this.session(login.connection, server, db);
      return await action(session);
    }
  }

  /** The endpoint's session for a saved login: pooled, inside the auth retry, dropped on error. */
  private remoteFor(db: LoginDb, login: Login, server: Record<string, unknown>): RemoteSession {
    const run = async <T>(action: (session: McpSession) => Promise<T>): Promise<T> => {
      try {
        return await this.withAuthRetry(db, login, server, action);
      } catch (error) {
        this.drop(String(login.connection.id));
        throw error;
      }
    };
    let listed: Promise<ConnectorTool[]> | null = null;
    return {
      initialize: () => run((session) => session.initialize()),
      list: () => {
        listed ??= run((session) => session.listTools()).then((tools) => tools.map(remoteConnectorTool));
        return listed;
      },
      call: (name, args) => run((session) => session.callTool(name, args)),
    };
  }

  /** An unpooled session for credentials that are not saved yet. */
  private remoteForCredentials(server: Record<string, unknown>, resolved: Resolved, credentials: Credentials): RemoteSession {
    const session = new McpSession(
      serverUrl(server),
      headersFor(credentialToken(credentials, resolved.manifest), resolved.manifest ?? serverManifest(server)),
      this.endpointFetch,
    );
    return {
      initialize: () => session.initialize(),
      list: async () => (await session.listTools()).map(remoteConnectorTool),
      call: (name, args) => session.callTool(name, args),
    };
  }

  private context(
    remote: RemoteSession,
    resolved: Resolved,
    connectionId: string,
    settings: Record<string, unknown>,
    workspaceDir?: string,
  ): ConnectorContext {
    return {
      http: this.fetchFn,
      remote: resolved.endpoint ? remote : NO_REMOTE,
      connection_id: connectionId,
      settings,
      ...(workspaceDir ? { workspace_dir: workspaceDir } : {}),
    };
  }

  /**
   * Runs adapter code on a saved login. An OAuth login gets a fresh token first, and a 401 from
   * the adapter gets one refresh and one retry. A `ConnectorError` leaves as an `McpError`.
   */
  private async onLogin<T>(
    db: LoginDb,
    login: Login,
    server: Record<string, unknown>,
    resolved: Resolved,
    work: (credentials: Credentials, ctx: ConnectorContext) => Promise<T>,
    workspaceDir?: string,
    settings?: Record<string, unknown>,
  ): Promise<T> {
    const attempt = () => {
      const ctx = this.context(
        this.remoteFor(db, login, server),
        resolved,
        String(login.connection.id),
        settings ?? connectionSettings(login.connection),
        workspaceDir,
      );
      const manifest = resolved.manifest ?? serverManifest(server);
      const instance = login.connection.owner_scope === "platform" && manifest?.auth.instance;
      return work(instance && manifest ? instanceCredentials(manifest) : connectionCredentials(login.connection), ctx);
    };
    try {
      if (isOauth(server)) {
        login.connection = await this.ready(db, login.connection, server);
      }
      try {
        return await attempt();
      } catch (error) {
        if (!isConnectorError(error) || error.status !== 401 || !isOauth(server)) {
          throw error;
        }
        login.connection = await this.refresh(db, login.connection, server);
        return await attempt();
      }
    } catch (error) {
      throw translateConnectorError(error);
    }
  }

  /** Runs adapter code on credentials that are not saved yet. */
  private async onCredentials<T>(
    server: Record<string, unknown>,
    credentials: Credentials,
    settings: Record<string, unknown>,
    work: (resolved: Resolved, ctx: ConnectorContext) => Promise<T>,
  ): Promise<T> {
    const resolved = this.resolve(server);
    const remote = resolved.endpoint ? this.remoteForCredentials(server, resolved, credentials) : NO_REMOTE;
    try {
      return await work(resolved, this.context(remote, resolved, "", settings));
    } catch (error) {
      throw translateConnectorError(error);
    }
  }

  private async validateWith(resolved: Resolved, credentials: Credentials, ctx: ConnectorContext): Promise<string> {
    if (resolved.adapter.validate) {
      return resolved.adapter.validate(credentials, ctx);
    }
    if (resolved.endpoint) {
      await ctx.remote.initialize();
    }
    return "";
  }

  private async listWith(resolved: Resolved, credentials: Credentials, ctx: ConnectorContext): Promise<ConnectorTool[]> {
    if (resolved.adapter.list) {
      return resolved.adapter.list(credentials, ctx);
    }
    if (resolved.endpoint) {
      return ctx.remote.list();
    }
    return [...(resolved.manifest?.tools ?? [])];
  }

  /** Checks credentials and settings before they are saved. Returns the account hint. */
  async validate(
    server: Record<string, unknown>,
    credentials: Credentials,
    settings: Record<string, unknown> = {},
  ): Promise<string> {
    return this.onCredentials(server, credentials, settings, (resolved, ctx) =>
      this.validateWith(resolved, credentials, ctx),
    );
  }

  /** Values for a settings property marked `x-lookup`. */
  async lookup(
    server: Record<string, unknown>,
    property: string,
    query: string,
    credentials: Credentials,
    settings: Record<string, unknown> = {},
  ): Promise<LookupOption[]> {
    return this.onCredentials(server, credentials, settings, (resolved, ctx) => {
      if (!resolved.adapter.lookup) {
        throw new ConnectorError(`${String(server.slug)} has no lookup`, 404);
      }
      return resolved.adapter.lookup(property, query, credentials, ctx);
    });
  }

  /** Checks a saved login with the settings it is about to store. Returns the account hint. */
  async validateLogin(
    db: LoginDb,
    connection: Record<string, unknown>,
    server: Record<string, unknown>,
    settings: Record<string, unknown>,
  ): Promise<string> {
    const resolved = this.resolve(server);
    return this.onLogin(
      db,
      { connection },
      server,
      resolved,
      (credentials, ctx) => this.validateWith(resolved, credentials, ctx),
      undefined,
      settings,
    );
  }

  /** What a saved login's endpoint says about itself: its name and instructions. */
  async describeEndpoint(
    db: LoginDb,
    connection: Record<string, unknown>,
    server: Record<string, unknown>,
  ): Promise<RemoteInfo> {
    const resolved = this.resolve(server);
    return this.onLogin(db, { connection }, server, resolved, (_credentials, ctx) => ctx.remote.initialize());
  }

  /** Values for a settings property marked `x-lookup`, searched with a saved login. */
  async lookupLogin(
    db: LoginDb,
    connection: Record<string, unknown>,
    server: Record<string, unknown>,
    property: string,
    query: string,
  ): Promise<LookupOption[]> {
    const resolved = this.resolve(server);
    return this.onLogin(db, { connection }, server, resolved, (credentials, ctx) => {
      if (!resolved.adapter.lookup) {
        throw new ConnectorError(`${String(server.slug)} has no lookup`, 404);
      }
      return resolved.adapter.lookup(property, query, credentials, ctx);
    });
  }

  async syncTools(
    db: McpDatabase,
    connection: Record<string, unknown>,
    server: Record<string, unknown>,
    options: { force?: boolean; validate?: boolean } = {},
  ): Promise<ListedTool[]> {
    const force = options.force ?? false;
    const validate = options.validate ?? force;
    const now = new Date();
    const stored = await db.listMcpTools(String(connection.id));
    if (connection.status !== "connected" || (!force && this.catalogFresh(String(connection.id), now, stored))) {
      return listedFromRows(stored);
    }
    const resolved = this.resolve(server);
    const login: Login = { connection };
    const prefix = String(server.tool_prefix || server.slug);
    const tools = await this.onLogin(db, login, server, resolved, async (credentials, ctx) => {
      if (validate && resolved.adapter.validate) {
        await resolved.adapter.validate(credentials, ctx);
      }
      return this.listWith(resolved, credentials, ctx);
    });
    const manifest = resolved.manifest ?? serverManifest(server);
    const listed = tools.filter((tool) => !manifestExcludes(manifest, tool.name)).map((tool) => {
      const edited = overriddenTool(server, {
        remote_name: tool.name,
        description: tool.description,
        input_schema: schemaObj(tool.input_schema),
      });
      return new ListedTool(
        tool.name,
        namespacedName(prefix, tool.name),
        edited.description,
        edited.input_schema,
        tool.read_only_hint ?? null,
        tool.destructive_hint ?? null,
      );
    });
    await this.persistTools(db, login.connection, server, listed, now);
    return listed;
  }

  async call(
    db: McpDatabase,
    connection: Record<string, unknown>,
    server: Record<string, unknown>,
    remoteName: string,
    arguments_: Record<string, unknown>,
    extras: { workspaceDir?: string; orgId?: string } = {},
  ): Promise<string> {
    const metered = connection.owner_scope === "platform" && extras.orgId ? extras.orgId : null;
    if (metered !== null) {
      const refusal = await this.overCap(db, metered, server);
      if (refusal !== null) {
        return refusal;
      }
    }
    try {
      let argumentsForCall = arguments_;
      try {
        const listed = listedFromRows(await db.listMcpTools(String(connection.id)));
        const tool = listed.find((item) => item.remote_name === remoteName);
        argumentsForCall = omitEmptyOptionalStrings(arguments_, tool?.input_schema);
      } catch {
        argumentsForCall = arguments_;
      }
      try {
        return await this.invokeCall(db, connection, server, remoteName, argumentsForCall, extras);
      } finally {
        if (metered !== null) {
          await db.recordConnectorCall(metered, String(server.id), utcMonth(), new Date());
        }
      }
    } catch (error) {
      const status = error instanceof McpError ? error.status : null;
      const level =
        error instanceof McpDisconnectedError || (typeof status === "number" && status < 500)
          ? "warn"
          : "error";
      writeLog(
        level,
        error instanceof Error ? error.message : String(error),
        {
          source: "backend",
          operation: "mcp.call",
          error_type: error instanceof Error ? error.name : "Error",
        },
        error,
      );
      throw error;
    }
  }

  /**
   * The tool result for a call the organisation's cap on this connector's platform login
   * refuses this month, or null while it may call.
   */
  private async overCap(db: McpDatabase, orgId: string, server: Record<string, unknown>): Promise<string | null> {
    if (this.policy === null) {
      return null;
    }
    const { limits } = await this.policy.standing(orgId);
    const slug = String(server.slug);
    const cap = limits.monthlyConnectorCalls[slug];
    if (cap === undefined) {
      return null;
    }
    const calls = await db.countConnectorCalls(orgId, String(server.id), utcMonth());
    return calls >= cap ? `ERROR: ${limits.source} limit reached: ${slug} calls this month` : null;
  }

  private async invokeCall(
    db: McpDatabase,
    connection: Record<string, unknown>,
    server: Record<string, unknown>,
    remoteName: string,
    arguments_: Record<string, unknown>,
    extras: { workspaceDir?: string } = {},
  ): Promise<string> {
    if (connection.status !== "connected") {
      throw new McpDisconnectedError("connection is not connected");
    }
    const resolved = this.resolve(server);
    return this.onLogin(
      db,
      { connection },
      server,
      resolved,
      (credentials, ctx) =>
        resolved.adapter.call
          ? resolved.adapter.call(remoteName, arguments_, credentials, ctx)
          : ctx.remote.call(remoteName, arguments_),
      extras.workspaceDir,
    );
  }

  /**
   * The State entries connectors add for one agent: every connector with a `state` hook whose
   * server the agent has on with a connected login. Hooks run in parallel under one budget; a
   * hook that fails, times out, or returns too much yields `{ unavailable }` under its key.
   */
  async state(db: StateDatabase, agent: Record<string, unknown>): Promise<Record<string, unknown>> {
    const entries = this.registry.entries().filter((entry) => entry.manifest.state && entry.adapter.state);
    if (!entries.length) {
      return {};
    }
    const orgId = typeof agent.org_id === "string" ? agent.org_id : null;
    const servers = (await db.listMcpServers(orgId)) as Array<Record<string, unknown>>;
    const values = await Promise.all(
      entries.map(async (entry): Promise<[string, unknown] | null> => {
        const key = entry.manifest.state!.key;
        const server = servers.find((row) => row.id === entry.id);
        const connection = server ? await agentMcpConnection(db, agent, entry.manifest.slug) : null;
        if (!server || !connection) {
          return null;
        }
        const secrets = loginSecrets(connection, entry.manifest);
        try {
          const value = await withTimeout(
            this.onLogin(db, { connection }, server, this.resolve(server), (creds, ctx) => entry.adapter.state!(creds, ctx)),
            STATE_TIMEOUT_MS,
            `timed out after ${STATE_TIMEOUT_MS} ms`,
          );
          if (value === null || value === undefined) {
            return null;
          }
          const text = redact(JSON.stringify(value), secrets);
          if (Buffer.byteLength(text, "utf8") > STATE_MAX_BYTES) {
            throw new Error(`value exceeds ${STATE_MAX_BYTES} bytes`);
          }
          return [key, JSON.parse(text)];
        } catch (error) {
          const reason = error instanceof Error && error.message ? error.message : "state hook failed";
          writeLog("warn", `connector state ${entry.manifest.slug}: ${reason}`, {
            source: "backend",
            operation: "mcp.state",
          });
          return [key, { unavailable: reason }];
        }
      }),
    );
    return Object.fromEntries(values.filter((value): value is [string, unknown] => value !== null));
  }
}
