import { decryptPayload, encryptPayload } from "../credentials/crypto.js";
import type { OwnerScope } from "../credentials/validate.js";
import type {
  McpConnectionRow,
} from "../db/mcp.js";
import { newId } from "../lib/ids.js";
import { McpDisconnectedError, McpError } from "../mcp/errors.js";
import type { McpPool } from "../mcp/pool.js";
import { retireLogin, type LoginFailure } from "../mcp/service.js";
import { authFields } from "./manifest.js";
import type { ConnectorRegistry } from "./registry.js";
import { installedConnectors } from "./index.js";
import { settingsComplete, SettingsError, validateSettings } from "./settings.js";
import type { Credentials } from "./types.js";
import { connectMcp, getMcpConnectionForOwner } from "../db/mcp.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import type { LoadedConnector } from "./load.js";

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

/** The db/ functions a login is connected and bound through, and the retiring of it, on `db`. */
export function connectDatabase(db: Queryable) {
  return {
    getMcpConnectionForOwner: bindQuery(db, getMcpConnectionForOwner),
    connectMcp: bindQuery(db, connectMcp),
    /** Retires a login that stopped working, and `pool` forgets it (`retireLogin`). */
    retireLogin: (pool: ConnectPool, connection: McpConnectionRow, failure: LoginFailure) =>
      retireLogin(pool, db, connection, failure),
  };
}

export type ConnectDatabase = ReturnType<typeof connectDatabase>;

/** The form's values for a token login, by field: every declared field trimmed, the required ones present. */
export function tokenCredentials(
  server: LoadedConnector,
  values: Record<string, unknown>,
  connectors: ConnectorRegistry = installedConnectors(),
): Credentials {
  const manifest = connectors.forServer(server)?.manifest;
  const fields = manifest ? authFields(manifest) : [{ name: "token", label: "API key", optional: false }];
  const credentials: Record<string, string> = {};
  for (const field of fields) {
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

/** Answers a connector's failure: a rejected credential or a bad setting is a 422, anything else upstream a 502. */
export function connectFailure(error: unknown, server: LoadedConnector): never {
  if (error instanceof McpError && !(error instanceof McpDisconnectedError)) {
    if (error.status === 401 || error.status === 403) {
      throw new ConnectError(422, "api key was rejected");
    }
    if (error.status === 422) {
      throw new ConnectError(422, error.message);
    }
    throw new ConnectError(502, `${String(server.display_name ?? server.slug)}: ${error.message}`);
  }
  throw error;
}

/**
 * Connects a token login: checks the credentials against the manifest's fields, applies
 * `onExisting` to the owner's stored login, runs the connector's `validate`, stores the
 * credentials encrypted, and lists the login's tools. A listing the server rejects removes the
 * new login, or disconnects the one it replaced; any other listing failure leaves it for the next sync.
 */
export async function connect(
  db: ConnectDatabase,
  pool: ConnectPool | null,
  input: ConnectInput,
  now: Date = new Date(),
  options: { masterKey?: Buffer | undefined; connectors?: ConnectorRegistry } = {},
): Promise<ConnectResult> {
  const { server } = input;
  if (server.auth !== "token") {
    throw new ConnectError(422, "connector does not take a key");
  }
  const credentials = tokenCredentials(server, input.credentials, options.connectors);
  const schema = (options.connectors ?? installedConnectors()).forServer(server)?.manifest.settings_schema;
  const settings = input.settings ?? {};
  if (schema && Object.keys(settings).length) {
    try {
      validateSettings(schema, settings);
    } catch (error) {
      if (error instanceof SettingsError) {
        throw new ConnectError(422, error.message);
      }
      throw error;
    }
  }
  const complete = settingsComplete(schema, settings);
  const onExisting = input.onExisting ?? "refuse";
  const existing = await db.getMcpConnectionForOwner(server.id, input.ownerScope, input.ownerId);
  if (existing !== null && existing.status === "connected") {
    if (onExisting === "refuse") {
      throw new ConnectError(409, "already connected; disconnect first");
    }
    if (onExisting === "keep") {
      return { connection: existing, outcome: "kept" };
    }
    if (sameCredentials(storedCredentials(existing, options.masterKey), credentials)) {
      return { connection: existing, outcome: "current" };
    }
    if (typeof onExisting === "object" && existing.account_hint !== onExisting.replace_when_hint) {
      return { connection: existing, outcome: "kept" };
    }
  }
  let hint = "";
  try {
    hint = pool ? await pool.validate(server, credentials, settings) : "";
  } catch (error) {
    connectFailure(error, server);
  }
  const [ciphertext, nonce] = encryptPayload({ ...credentials }, options.masterKey);
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
      settings,
    },
    now,
  );
  if (pool === null || !complete) {
    return { connection, outcome: "installed" };
  }
  try {
    await pool.syncTools(connection, server, { force: true, validate: false });
  } catch (error) {
    if (error instanceof McpError && (error.status === 401 || error.status === 403)) {
      await db.retireLogin(pool, connection, existing === null ? "never_connected" : "unauthorised");
      throw new ConnectError(422, "api key was rejected");
    }
  }
  return { connection, outcome: "installed" };
}
