// What starting a connector login and completing its sign-in share: the encrypted pending
// payload, the binding to its owner, and ending a sign-in that did not finish.
import type { LoadedConnector } from "../connectors/load.js";
import type { RemoteInfo } from "../connectors/types.js";
import { asBuffer, decryptPayload, encryptPayload } from "../credentials/crypto.js";
import { updateConnector } from "../db/connectors.js";
import { isPlainRecord } from "../db/json.js";
import { bindMcpConnection, getMcpConnectionByOauthState, type McpConnectionRow } from "../db/mcp.js";
import type { Queryable } from "../db/pg.js";
import type { Manifest } from "../db/schema/index.js";
import { newId } from "../lib/ids.js";
import { DESCRIPTION_MAX } from "../mcp/catalog.js";
import type { McpPool } from "../mcp/pool.js";
import { retireLogin } from "../mcp/service.js";
import { pendingReplaces } from "./index.js";

/** What connector logins are made through, built once from the app's services. */
export type ConnectFlowServices = {
  db: Queryable;
  /** The pool that talks to the connectors; absent on a box that calls none. */
  mcp: McpPool | null;
  /** The key logins are encrypted with; the process's own when absent. */
  masterKey: Buffer | undefined;
};

export type Payload = Record<string, unknown>;

export function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

export function encrypt(services: ConnectFlowServices, payload: Payload): [Buffer, Buffer] {
  return services.masterKey ? encryptPayload(payload, services.masterKey) : encryptPayload(payload);
}

export function decrypt(services: ConnectFlowServices, row: McpConnectionRow): Payload {
  return decryptPayload(asBuffer(row.ciphertext), asBuffer(row.nonce), services.masterKey);
}

/** A pending payload's `oauth` object; none when it holds none. */
export function oauthOf(pending: Payload): Payload {
  return isPlainRecord(pending.oauth) ? pending.oauth : {};
}

/** Binds a login to its owner, so its owner's agents use it. */
export async function bindToOwner(
  db: Queryable,
  connection: McpConnectionRow,
  now: Date,
): Promise<void> {
  await bindMcpConnection(
    db,
    {
      bindingId: newId("bind"),
      serverId: connection.mcp_server_id,
      ownerScope: connection.owner_scope,
      ownerId: connection.owner_id,
      connectionId: connection.id,
    },
    now,
  );
}

/**
 * Ends a sign-in that did not finish: the login it replaces is marked disconnected, a new one is
 * deleted. `replaces` says which when the caller knows; otherwise the pending payload does.
 */
export async function discardAttempt(
  services: ConnectFlowServices,
  row: McpConnectionRow,
  replaces?: boolean,
): Promise<void> {
  let keep = replaces;
  if (keep === undefined) {
    try {
      keep = pendingReplaces(decrypt(services, row));
    } catch {
      keep = false;
    }
  }
  await retireLogin(services.mcp, services.db, row, keep ? "unauthorised" : "never_connected");
}

export async function abandonAttempt(
  services: ConnectFlowServices,
  state: string | undefined,
): Promise<void> {
  const row = state ? await getMcpConnectionByOauthState(services.db, state) : null;
  if (row !== null) {
    await discardAttempt(services, row);
  }
}

/** Which of a manifest's name and description are still blank. */
type BlankFields = { name: boolean; description: boolean };

/** The manifest with its blank name and description taken from what the endpoint says, cut to their limits. */
function filledManifest(manifest: Manifest, blank: BlankFields, info: RemoteInfo): Manifest {
  return {
    ...manifest,
    ...(blank.name && info.name ? { display_name: info.name.slice(0, 120) } : {}),
    ...(blank.description && info.instructions
      ? { description: info.instructions.slice(0, DESCRIPTION_MAX) }
      : {}),
  };
}

/**
 * Fills an organisation server's blank display name (its slug) and blank description from what
 * its endpoint says at `initialize`, once a login to it connects. A server that says nothing
 * keeps what it has.
 */
export async function fillFromEndpoint(
  services: ConnectFlowServices,
  connection: McpConnectionRow,
  server: LoadedConnector,
): Promise<void> {
  const { manifest } = server;
  const blank: BlankFields = {
    name: manifest.display_name === manifest.slug,
    description: !manifest.description.trim(),
  };
  if (
    !server.owner_org_id ||
    !services.mcp ||
    connection.status !== "connected" ||
    (!blank.name && !blank.description)
  ) {
    return;
  }
  try {
    const info = await services.mcp.describeEndpoint(connection, server);
    const next = filledManifest(manifest, blank, info);
    if (next.display_name !== manifest.display_name || next.description !== manifest.description) {
      await updateConnector(services.db, server.id, { manifest: next }, new Date());
    }
  } catch {
    // The server keeps the name and description it was added with.
  }
}
