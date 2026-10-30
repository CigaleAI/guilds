import { decryptPayload, encryptPayload } from "../credentials/crypto.js";
import type { OwnerScope } from "../credentials/validate.js";
import type {
  McpConnectionRow,
} from "../db/mcp.js";
import { newId } from "../lib/ids.js";
import { McpDisconnectedError, McpError } from "./errors.js";
import type { ConnectorLogin, McpPool } from "./pool.js";
import { retireLogin, type LoginFailure } from "./service.js";
import { authFields } from "../connectors/manifest.js";
import { serverManifest, settingsOutcome, type LoadedConnector, type SettingsOutcome } from "../connectors/servers.js";
import { SettingsError } from "../connectors/settings.js";
import type { Credentials } from "../connectors/types.js";
import { connectMcp, getMcpConnectionForOwner } from "../db/mcp.js";
import { bindQuery, type Queryable } from "../db/pg.js";

/**
 * What to do when the owner already has a connected login on the server. `refuse`: a 409.
 * `keep`: the stored login stays. `replace`: the new credentials replace it. `replace_when_hint`:
 * they replace it only when its account hint is this one; any other login stays.
 */
export type OnExisting = "refuse" | "keep" | "replace" | { replace_when_hint: string };

/** `installed`: the credentials are now the owner's login. `current`: they already were. `kept`: another login stays. */
export type ConnectOutcome = "installed" | "current" | "kept";

export type ConnectInput = {
  server: LoadedConnector;
  ownerScope: OwnerScope;
  ownerId: string | null;
  /** The form's values, by the manifest's field names. */
  credentials: Record<string, unknown>;
  /**
   * The login's settings, checked against the manifest's `settings_schema` and by the
   * connector's `validate`. A login whose schema has required properties it lacks is stored
   * pending until a settings save completes it.
   */
  settings?: Record<string, unknown>;
  onExisting?: OnExisting;
  /** Replaces the hint the connector's `validate` returns. */
  accountHint?: string;
};

export type ConnectResult = {
  connection: McpConnectionRow;
  outcome: ConnectOutcome;
};

export class ConnectError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ConnectError";
    this.status = status;
  }
}

/** The pool a login is validated, listed and forgotten through. */
export type ConnectPool = Pick<McpPool, "validate" | "syncTools" | "forget">;

/** What a token login is connected through, built once from the app's services. */
export type ConnectServices = {
  /** The pool that talks to the connectors; absent on a box that calls none. */
  mcp: ConnectPool | null;
  /** The key logins are encrypted with; the process's own when absent. */
  masterKey: Buffer | undefined;
};

/** A db/ function with its connection bound. */
type BoundQuery<F> = F extends (db: Queryable, ...args: infer A) => infer R ? (...args: A) => R : never;

/** The db/ functions a login is connected and bound through, and the retiring of it. */
export type ConnectDatabase = {
  getMcpConnectionForOwner: BoundQuery<typeof getMcpConnectionForOwner>;
  connectMcp: BoundQuery<typeof connectMcp>;
  /** Retires a login that stopped working, and `pool` forgets it (`retireLogin`). */
  retireLogin: (pool: ConnectPool, connection: McpConnectionRow, failure: LoginFailure) => Promise<void>;
};

/** The db/ functions a login is connected and bound through, and the retiring of it, on `db`. */
export function connectDatabase(db: Queryable): ConnectDatabase {
  return {
    getMcpConnectionForOwner: bindQuery(db, getMcpConnectionForOwner),
    connectMcp: bindQuery(db, connectMcp),
    retireLogin: (pool, connection, failure) => retireLogin(pool, db, connection, failure),
  };
}

/** The form's values for a token login, by field: every declared field trimmed, the required ones present. */
export function tokenCredentials(server: LoadedConnector, values: Record<string, unknown>): Credentials {
  const credentials: Record<string, string> = {};
  for (const field of authFields(serverManifest(server))) {
    const raw = values[field.name];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value && !field.optional) {
      throw new ConnectError(422, `${field.label.toLowerCase()} is required`);
    }
    credentials[field.name] = value;
  }
  return credentials;
}

function sameCredentials(stored: Record<string, unknown>, credentials: Credentials): boolean {
  return Object.entries(credentials).every(([name, value]) => (stored[name] ?? "") === value);
}

function storedCredentials(
  connection: Pick<McpConnectionRow, "ciphertext" | "nonce">,
  masterKey: Buffer | undefined,
): Record<string, unknown> {
  try {
    return decryptPayload(connection.ciphertext, connection.nonce, masterKey);
  } catch {
    return {};
  }
}

/**
 * The error a connector's failure answers: a rejected credential or a bad setting is a 422
 * `ConnectError`, any other failure upstream a 502; an error that is not the connector's stays.
 */
export function translateConnectFailure(error: unknown, server: LoadedConnector): unknown {
  if (!(error instanceof McpError) || error instanceof McpDisconnectedError) {
    return error;
  }
  if (error.status === 401 || error.status === 403) {
    return new ConnectError(422, "api key was rejected");
  }
  if (error.status === 422) {
    return new ConnectError(422, error.message);
  }
  return new ConnectError(502, `${String(server.display_name ?? server.slug)}: ${error.message}`);
}

/** The login's settings checked against the manifest's `settings_schema`; a setting it refuses is a 422. */
function validateConnectSettings(server: LoadedConnector, values: Record<string, unknown>): SettingsOutcome {
  try {
    return settingsOutcome(server, values);
  } catch (error) {
    if (error instanceof SettingsError) {
      throw new ConnectError(422, error.message);
    }
    throw error;
  }
}

/**
 * What `onExisting` makes of the owner's stored login: a 409 when it refuses, the login kept or
 * already current, or null when none is connected or the credentials replace it.
 */
function resolveExistingLogin(
  existing: McpConnectionRow | null,
  onExisting: OnExisting,
  credentials: Credentials,
  masterKey: Buffer | undefined,
): ConnectResult | null {
  if (existing === null || existing.status !== "connected") {
    return null;
  }
  if (onExisting === "refuse") {
    throw new ConnectError(409, "already connected; disconnect first");
  }
  if (onExisting === "keep") {
    return { connection: existing, outcome: "kept" };
  }
  if (sameCredentials(storedCredentials(existing, masterKey), credentials)) {
    return { connection: existing, outcome: "current" };
  }
  if (typeof onExisting === "object" && existing.account_hint !== onExisting.replace_when_hint) {
    return { connection: existing, outcome: "kept" };
  }
  return null;
}

/** The account hint the connector's `validate` gives the credentials, none without a pool; a failure is the error it answers. */
async function validateCredentials(
  pool: ConnectPool | null,
  server: LoadedConnector,
  credentials: Credentials,
  settings: Record<string, unknown>,
): Promise<string> {
  if (pool === null) {
    return "";
  }
  try {
    return await pool.validate(server, credentials, settings);
  } catch (error) {
    throw translateConnectFailure(error, server);
  }
}

/**
 * Lists a new login's tools. A listing the server refuses with 401 or 403 retires the login as
 * `failure` says and is a 422; any other listing failure leaves the tools for the next sync.
 */
async function listNewLoginTools(
  db: ConnectDatabase,
  pool: ConnectPool,
  login: ConnectorLogin,
  failure: LoginFailure,
): Promise<void> {
  try {
    await pool.syncTools(login.connection, login.server, { force: true, validate: false });
  } catch (error) {
    if (error instanceof McpError && (error.status === 401 || error.status === 403)) {
      await db.retireLogin(pool, login.connection, failure);
      throw new ConnectError(422, "api key was rejected");
    }
  }
}

/**
 * Connects a token login: checks the credentials against the manifest's fields, applies
 * `onExisting` to the owner's stored login, runs the connector's `validate`, stores the
 * credentials encrypted, and lists the login's tools. A listing the server rejects removes the
 * new login, or disconnects the one it replaced; any other listing failure leaves it for the next sync.
 */
export async function connect(
  db: ConnectDatabase,
  services: ConnectServices,
  input: ConnectInput,
  now: Date = new Date(),
): Promise<ConnectResult> {
  const { server } = input;
  if (server.auth !== "token") {
    throw new ConnectError(422, "connector does not take a key");
  }
  const credentials = tokenCredentials(server, input.credentials);
  const settings = validateConnectSettings(server, input.settings ?? {});
  const complete = settings.kind === "complete";
  const existing = await db.getMcpConnectionForOwner(server.id, input.ownerScope, input.ownerId);
  const resolved = resolveExistingLogin(existing, input.onExisting ?? "refuse", credentials, services.masterKey);
  if (resolved !== null) {
    return resolved;
  }
  const hint = await validateCredentials(services.mcp, server, credentials, settings.values);
  const [ciphertext, nonce] = encryptPayload({ ...credentials }, services.masterKey);
  const connection = await db.connectMcp(
    {
      connectionId: newId("conn"),
      bindingId: newId("bind"),
      serverId: server.id,
      ownerScope: input.ownerScope,
      ownerId: input.ownerId,
      ciphertext,
      nonce,
      status: complete ? "connected" : "pending",
      accountHint: input.accountHint ?? hint,
      settings: settings.values,
    },
    now,
  );
  if (services.mcp !== null && complete) {
    const failure = existing === null ? "never_connected" : "unauthorised";
    await listNewLoginTools(db, services.mcp, { connection, server }, failure);
  }
  return { connection, outcome: "installed" };
}
