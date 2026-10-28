import type { ConnectionSettings } from "../db/schema/index.js";
import type { FetchFn } from "../net/http.js";

/** A login's decrypted credentials, keyed by the manifest's field names. Values are trimmed strings. */
export type Credentials = Readonly<Record<string, string>>;

/** One tool a connector offers: the manifest fields plus the annotations a listing returned. */
export type ConnectorTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  mutating?: boolean;
  read_only_hint?: boolean | null;
  destructive_hint?: boolean | null;
};

/**
 * One value a settings property marked `x-lookup` may take: `value` is what the setting stores,
 * `label` what the search box shows, with an optional `detail` and `image` beside it.
 */
export type LookupOption = { value: unknown; label: string; detail?: string; image?: string };

/**
 * The pool's facade over a connector endpoint's MCP session. `list` and `call` run inside the
 * pool's auth retry and drop the session on error, so an adapter never holds a session.
 */
/** What a remote server says about itself when a session starts. */
export type RemoteInfo = { name: string; instructions: string };

export type RemoteSession = {
  initialize(): Promise<RemoteInfo>;
  list(): Promise<ConnectorTool[]>;
  call(name: string, args: Record<string, unknown>): Promise<string>;
};

export type ConnectorContext = {
  /** Proxy-aware, with the timeout. */
  http: FetchFn;
  /** The endpoint's session. Using it on a connector with no endpoint throws. */
  remote: RemoteSession;
  connection_id: string;
  /** The login's settings. */
  settings: Readonly<ConnectionSettings>;
  /** The agent's workspace when the call comes from a run. */
  workspace_dir?: string;
};

export type Adapter = {
  /**
   * Checks the credentials and settings. Returns the account hint, empty when there is none.
   * Runs at Connect and at every settings change. Default: `initialize` against the endpoint.
   */
  validate?(creds: Credentials, ctx: ConnectorContext): Promise<string>;
  /** Values for a settings property marked `x-lookup`. Runs with the login's credentials, or the form's before the login exists. */
  lookup?(property: string, query: string, creds: Credentials, ctx: ConnectorContext): Promise<LookupOption[]>;
  /** The tools this login lists. Default: the manifest's tools, or the endpoint's `tools/list` when there is one. */
  list?(creds: Credentials, ctx: ConnectorContext): Promise<ConnectorTool[]>;
  /** Runs one tool. Default: the endpoint's `tools/call`. Required when there is no endpoint. */
  call?(name: string, args: Record<string, unknown>, creds: Credentials, ctx: ConnectorContext): Promise<string>;
  /** The value for the manifest's `state.key`, once per generation, under the pool's budget. Null leaves the key out. */
  state?(creds: Credentials, ctx: ConnectorContext): Promise<unknown>;
};

/** The one error an adapter throws. A 401 on an OAuth connector gets one refresh and one retry. */
export class ConnectorError extends Error {
  status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ConnectorError";
    this.status = status;
  }
}

/**
 * Whether `error` is a `ConnectorError`: this module's class, or the copy a bundled adapter
 * carries, which has the same name and status but not the same prototype.
 */
export function isConnectorError(error: unknown): error is ConnectorError {
  if (error instanceof ConnectorError) {
    return true;
  }
  const status = (error as { status?: unknown } | null)?.status;
  return error instanceof Error && error.name === "ConnectorError" && (status === null || typeof status === "number");
}

type StatusError = Error & { status: number | null };

/** Runs `work` and rethrows an error of `kind` as a `ConnectorError` with the same message and status. */
export async function translated<T>(
  kind: abstract new (...args: never[]) => StatusError,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof kind) {
      throw new ConnectorError(error.message, error.status);
    }
    throw error;
  }
}

/** The named credential, or a 401 `ConnectorError` with `message` when it is empty. */
export function requiredCredential(creds: Credentials, name: string, message: string): string {
  const value = creds[name] ?? "";
  if (!value) {
    throw new ConnectorError(message, 401);
  }
  return value;
}
