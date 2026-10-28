import { installedConnectors } from "../connectors/index.js";
import { instanceCredentials } from "../connectors/instance.js";
import { manifestExcludes, overriddenTool, serverManifest, toolStartsOff, type LoadedConnector } from "../connectors/load.js";
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
import { jsonObj } from "../db/json.js";
import type { McpConnectionRow, McpToolRow } from "../db/mcp.js";
import type { Manifest } from "../db/schema/index.js";
import { utcMonth } from "../db/usage.js";
import { TOKEN_REFRESH_MS } from "../github/tokens.js";
import { newId } from "../lib/ids.js";
import { proxyFetch, type FetchFn } from "../net/http.js";
import { writeLog } from "../observability/log.js";
import type { OrgPolicy } from "../policy/index.js";
import { redact } from "../secrets/index.js";
import { omitEmptyOptionalStrings } from "../toolbox/schema.js";
import { McpDisconnectedError, McpError } from "./errors.js";
import { namespacedName } from "./names.js";
import { ListedTool, listedFromRows, remoteConnectorTool } from "./tools.js";
import { CALL_TOOL_TIMEOUT_MS, McpSession, publicOnly } from "./session.js";
import type { McpDatabase } from "./database.js";
import {
  connectionCredentials,
  credentialToken,
  headersFor,
  isOauth,
  loginSecrets,
  readyLogin,
  refreshLogin,
  resolveSessionAuth,
  withAuthRetry,
  type Login,
} from "./login-auth.js";

export const TOOLS_TTL_MS = 10 * 60 * 1000;
/** Run start waits at most this long for every connector's State hook before running without them. */
export const STATE_TIMEOUT_MS = 5_000;
/** A State hook's value is replaced with `unavailable` above this many serialised bytes. */
export const STATE_MAX_BYTES = 32_000;

function latestListedAt(rows: McpToolRow[]): number | null {
  let latest = 0;
  for (const row of rows) {
    const ms = Date.parse(row.listed_at);
    if (Number.isFinite(ms) && ms > latest) {
      latest = ms;
    }
  }
  return latest > 0 ? latest : null;
}

function serverUrl(server: LoadedConnector): string {
  const config = jsonObj(server.config);
  const url = config && typeof config === "object" && !Array.isArray(config)
    ? (config as { url?: unknown }).url
    : undefined;
  if (typeof url !== "string" || !url.trim()) {
    throw new McpError("mcp server is missing a url");
  }
  return url.trim();
}

/** A login and the connector it signs into. */
export type ConnectorLogin = { connection: McpConnectionRow; server: LoadedConnector };

/**
 * Who makes a tool call: the organisation a call on a platform login counts against, and the
 * agent workspace an adapter reads and writes files in. An operator's call has neither.
 */
export type McpCaller = { orgId: string | null; workspaceDir: string | null };

/** The caller of a call no agent makes: it counts against no organisation and has no workspace. */
export const OPERATOR_CALLER: McpCaller = { orgId: null, workspaceDir: null };

/** A call of one of a login's remote tools: its name on the remote, its arguments, and who calls it. */
export type RemoteCall = { tool: string; arguments: Record<string, unknown>; caller: McpCaller };

/** A pooled session and when the credential it sends expires. */
type PooledSession = { session: McpSession; expiresAt: number | null };

/** A server's connector: its manifest and adapter, or the plain MCP client for a server created by hand. */
type Resolved = {
  manifest: Manifest | null;
  adapter: Adapter;
  endpoint: boolean;
};

function translateConnectorError(error: unknown): unknown {
  return isConnectorError(error) ? new McpError(error.message, error.status) : error;
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

/** Studio's stand-in for `McpPool.state`: each key the connectors of an agent's logins fill, without calling them. */
export function previewConnectorState(
  logins: ConnectorLogin[],
  connectors: ConnectorRegistry = installedConnectors(),
): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  for (const entry of connectors.entries()) {
    if (entry.manifest.state && logins.some((login) => login.server.id === entry.id)) {
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
  /** The db/ functions the pool reads and writes logins, tool listings and call counts through. */
  readonly database: McpDatabase;

  /** The login's pooled session, reopened once the credential it sends is within `TOKEN_REFRESH_MS` of expiry. */
  session: (connection: McpConnectionRow, server: LoadedConnector) => Promise<McpSession>;

  constructor(database: McpDatabase, toolsTtlMs = TOOLS_TTL_MS, proxyUrl = "") {
    this.database = database;
    this.toolsTtlMs = toolsTtlMs;
    this.proxyUrl = proxyUrl;
    this.fetchFn = proxyFetch(this.proxyUrl);
    this.endpointFetch = publicOnly(proxyFetch(this.proxyUrl, CALL_TOOL_TIMEOUT_MS));
    this.session = async (connection, server) => {
      const connectionId = connection.id;
      const current = this.sessions.get(connectionId);
      if (current && (current.expiresAt === null || current.expiresAt - Date.now() > TOKEN_REFRESH_MS)) {
        return current.session;
      }
      const auth = await resolveSessionAuth(this, this.registry, connection, server);
      const opened = new McpSession(serverUrl(server), auth.headers, this.endpointFetch);
      this.sessions.set(connectionId, { session: opened, expiresAt: auth.expiresAt });
      return opened;
    };
  }

  private get registry(): ConnectorRegistry {
    return this.connectors ?? installedConnectors();
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

  private resolve(server: LoadedConnector): Resolved {
    const entry = this.registry.forServer(server);
    if (entry === null) {
      return { manifest: null, adapter: {}, endpoint: true };
    }
    return { manifest: entry.manifest, adapter: entry.adapter, endpoint: Boolean(entry.manifest.endpoint) };
  }

  private catalogFresh(
    connectionId: string,
    now: Date,
    stored: McpToolRow[] = [],
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
    connection: McpConnectionRow,
    server: LoadedConnector,
    listed: ListedTool[],
    now: Date,
  ): Promise<void> {
    await this.database.replaceMcpTools(connection.id, listed, now);
    await this.writeDefaultOff(connection, server, listed, now);
    this.syncedAt.set(connection.id, now.getTime());
  }

  /** Writes an Off overlay at the login's owner for each listed tool that starts Off, unless one is there. */
  private async writeDefaultOff(
    connection: McpConnectionRow,
    server: LoadedConnector,
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
      await this.database.insertBindingIfAbsent(
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

  /** The endpoint's session for a saved login: pooled, inside the auth retry, dropped on error. */
  private remoteFor(login: Login, server: LoadedConnector): RemoteSession {
    const run = async <T>(action: (session: McpSession) => Promise<T>): Promise<T> => {
      try {
        return await withAuthRetry(this, login, server, action);
      } catch (error) {
        this.drop(login.connection.id);
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
  private remoteForCredentials(server: LoadedConnector, resolved: Resolved, credentials: Credentials): RemoteSession {
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
    login: Login,
    server: LoadedConnector,
    resolved: Resolved,
    work: (credentials: Credentials, ctx: ConnectorContext) => Promise<T>,
    workspaceDir?: string,
    settings?: Record<string, unknown>,
  ): Promise<T> {
    const attempt = () => {
      const ctx = this.context(
        this.remoteFor(login, server),
        resolved,
        login.connection.id,
        settings ?? login.connection.settings,
        workspaceDir,
      );
      const manifest = resolved.manifest ?? serverManifest(server);
      const instance = login.connection.owner_scope === "platform" && manifest?.auth.instance;
      return work(instance && manifest ? instanceCredentials(manifest) : connectionCredentials(login.connection), ctx);
    };
    try {
      if (isOauth(server)) {
        login.connection = await readyLogin(this, login.connection, server);
      }
      try {
        return await attempt();
      } catch (error) {
        if (!isConnectorError(error) || error.status !== 401 || !isOauth(server)) {
          throw error;
        }
        login.connection = await refreshLogin(this, login.connection, server);
        return await attempt();
      }
    } catch (error) {
      throw translateConnectorError(error);
    }
  }

  /** Runs adapter code on credentials that are not saved yet. */
  private async onCredentials<T>(
    server: LoadedConnector,
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
    server: LoadedConnector,
    credentials: Credentials,
    settings: Record<string, unknown> = {},
  ): Promise<string> {
    return this.onCredentials(server, credentials, settings, (resolved, ctx) =>
      this.validateWith(resolved, credentials, ctx),
    );
  }

  /** Values for a settings property marked `x-lookup`. */
  async lookup(
    server: LoadedConnector,
    property: string,
    query: string,
    credentials: Credentials,
    settings: Record<string, unknown> = {},
  ): Promise<LookupOption[]> {
    return this.onCredentials(server, credentials, settings, (resolved, ctx) => {
      if (!resolved.adapter.lookup) {
        throw new ConnectorError(`${server.slug} has no lookup`, 404);
      }
      return resolved.adapter.lookup(property, query, credentials, ctx);
    });
  }

  /** Checks a saved login with the settings it is about to store. Returns the account hint. */
  async validateLogin(
    connection: McpConnectionRow,
    server: LoadedConnector,
    settings: Record<string, unknown>,
  ): Promise<string> {
    const resolved = this.resolve(server);
    return this.onLogin(
      { connection },
      server,
      resolved,
      (credentials, ctx) => this.validateWith(resolved, credentials, ctx),
      undefined,
      settings,
    );
  }

  /** What a saved login's endpoint says about itself: its name and instructions. */
  async describeEndpoint(connection: McpConnectionRow, server: LoadedConnector): Promise<RemoteInfo> {
    const resolved = this.resolve(server);
    return this.onLogin({ connection }, server, resolved, (_credentials, ctx) => ctx.remote.initialize());
  }

  /** Values for a settings property marked `x-lookup`, searched with a saved login. */
  async lookupLogin(
    connection: McpConnectionRow,
    server: LoadedConnector,
    property: string,
    query: string,
  ): Promise<LookupOption[]> {
    const resolved = this.resolve(server);
    return this.onLogin({ connection }, server, resolved, (credentials, ctx) => {
      if (!resolved.adapter.lookup) {
        throw new ConnectorError(`${server.slug} has no lookup`, 404);
      }
      return resolved.adapter.lookup(property, query, credentials, ctx);
    });
  }

  async syncTools(
    connection: McpConnectionRow,
    server: LoadedConnector,
    options: { force?: boolean; validate?: boolean } = {},
  ): Promise<ListedTool[]> {
    const force = options.force ?? false;
    const validate = options.validate ?? force;
    const now = new Date();
    const stored = await this.database.listMcpTools(connection.id);
    if (connection.status !== "connected" || (!force && this.catalogFresh(connection.id, now, stored))) {
      return listedFromRows(stored);
    }
    const resolved = this.resolve(server);
    const login: Login = { connection };
    const prefix = String(server.tool_prefix || server.slug);
    const tools = await this.onLogin(login, server, resolved, async (credentials, ctx) => {
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
        input_schema: tool.input_schema,
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
    await this.persistTools(login.connection, server, listed, now);
    return listed;
  }

  /**
   * Calls one of a login's remote tools and answers its result as text. A call on a platform
   * login counts against the caller's organisation, whose cap may refuse it.
   */
  async call(connection: McpConnectionRow, server: LoadedConnector, call: RemoteCall): Promise<string> {
    const metered = connection.owner_scope === "platform" && call.caller.orgId ? call.caller.orgId : null;
    if (metered !== null) {
      const refusal = await this.overCap(metered, server);
      if (refusal !== null) {
        return refusal;
      }
    }
    try {
      let argumentsForCall = call.arguments;
      try {
        const listed = listedFromRows(await this.database.listMcpTools(connection.id));
        const tool = listed.find((item) => item.remote_name === call.tool);
        argumentsForCall = omitEmptyOptionalStrings(call.arguments, tool?.input_schema);
      } catch {
        argumentsForCall = call.arguments;
      }
      try {
        return await this.invokeCall(connection, server, { ...call, arguments: argumentsForCall });
      } finally {
        if (metered !== null) {
          await this.database.recordConnectorCall(metered, server.id, utcMonth(), new Date());
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
  private async overCap(orgId: string, server: LoadedConnector): Promise<string | null> {
    if (this.policy === null) {
      return null;
    }
    const { limits } = await this.policy.standing(orgId);
    const slug = server.slug;
    const cap = limits.monthlyConnectorCalls[slug];
    if (cap === undefined) {
      return null;
    }
    const calls = await this.database.countConnectorCalls(orgId, server.id, utcMonth());
    return calls >= cap ? `ERROR: ${limits.source} limit reached: ${slug} calls this month` : null;
  }

  private async invokeCall(connection: McpConnectionRow, server: LoadedConnector, call: RemoteCall): Promise<string> {
    if (connection.status !== "connected") {
      throw new McpDisconnectedError("connection is not connected");
    }
    const resolved = this.resolve(server);
    return this.onLogin(
      { connection },
      server,
      resolved,
      (credentials, ctx) =>
        resolved.adapter.call
          ? resolved.adapter.call(call.tool, call.arguments, credentials, ctx)
          : ctx.remote.call(call.tool, call.arguments),
      call.caller.workspaceDir ?? undefined,
    );
  }

  /**
   * The State entries connectors add for an agent's logins: every connector with a `state` hook
   * one of the logins signs into. Hooks run in parallel under one budget; a hook that fails,
   * times out, or returns too much yields `{ unavailable }` under its key.
   */
  async state(logins: ConnectorLogin[]): Promise<Record<string, unknown>> {
    const entries = this.registry.entries().filter((entry) => entry.manifest.state && entry.adapter.state);
    if (!entries.length) {
      return {};
    }
    const values = await Promise.all(
      entries.map(async (entry): Promise<[string, unknown] | null> => {
        const key = entry.manifest.state!.key;
        const login = logins.find((item) => item.server.id === entry.id);
        if (!login) {
          return null;
        }
        const { connection, server } = login;
        const secrets = loginSecrets(connection, entry.manifest);
        try {
          const value = await withTimeout(
            this.onLogin({ connection }, server, this.resolve(server), (creds, ctx) => entry.adapter.state!(creds, ctx)),
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
