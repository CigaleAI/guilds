import { decryptPayload } from "../credentials/crypto.js";
import { jsonObj } from "../db/json.js";
import type { Repositories } from "../db/repositories.js";
import { listedFromRows, McpError, isReadOnlyRemote } from "../mcp/index.js";
import { tokenRedactions } from "../oauth/index.js";
import { redact } from "../secrets/index.js";
import { capBytes } from "../toolbox/output.js";
import { STUDIO_TOOL_RESULT_MAX_BYTES } from "./constants.js";
import { StudioError, StudioUnprocessableError } from "./errors.js";

export const STUDIO_CONNECTION_ACCESS_WIDGET = "studio_connection_access";

export type StudioLoginStatus = "pending" | "granted" | "declined";

/** A login request the coach made: its tool message and the connection it names. */
export type LoginRecord = {
  seq: number;
  connectionId: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

function widgetOf(payload: Record<string, unknown>): Record<string, unknown> | null {
  if (payload.role !== "tool" || typeof payload.content !== "string") return null;
  try {
    return jsonObj(JSON.parse(payload.content)) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

/** The login request at a tool message seq; anything else there is not found. */
export function findLoginRecord(message: Record<string, unknown> | null, seq: number): LoginRecord {
  const payload = (jsonObj(message?.payload) as Record<string, unknown> | null) ?? {};
  const widget = widgetOf(payload);
  const connection = (jsonObj(widget?.connection) as Record<string, unknown> | null) ?? {};
  if (!message || widget?.widget !== STUDIO_CONNECTION_ACCESS_WIDGET || typeof connection.id !== "string") {
    throw new StudioError(404, "login request not found");
  }
  return {
    seq,
    connectionId: connection.id,
    payload,
    metadata: (jsonObj(message.metadata) as Record<string, unknown> | null) ?? {},
  };
}

export function loginStatus(record: LoginRecord): StudioLoginStatus {
  const status = record.metadata.access_status;
  return status === "granted" || status === "declined" ? status : "pending";
}

export type StudioMcpClient = {
  call(
    db: Repositories,
    connection: Record<string, unknown>,
    server: Record<string, unknown>,
    remoteName: string,
    arguments_: Record<string, unknown>,
  ): Promise<string>;
};

export type ReachableConnection = {
  connection: Record<string, unknown>;
  server: Record<string, unknown>;
};

// A connection is in Studio's reach when an agent of the source guild could
// inherit it: platform, this organisation, this guild, or a live member.
export async function reachableConnection(
  repo: Repositories,
  orgId: string,
  guildId: string,
  connectionId: string,
): Promise<ReachableConnection | null> {
  const connection = await repo.getMcpConnection(connectionId);
  if (!connection) {
    return null;
  }
  const scope = String(connection.owner_scope);
  const ownerId = connection.owner_id === null || connection.owner_id === undefined ? null : String(connection.owner_id);
  let reachable = false;
  if (scope === "platform") {
    reachable = true;
  } else if (scope === "org") {
    reachable = ownerId === orgId;
  } else if (scope === "guild") {
    reachable = ownerId === guildId;
  } else if (scope === "agent" && ownerId) {
    const agent = await repo.getAgent(ownerId);
    reachable = Boolean(agent && String(agent.guild_id) === guildId);
  }
  if (!reachable) {
    return null;
  }
  const server = await repo.getMcpServer(String(connection.mcp_server_id));
  if (!server) {
    return null;
  }
  return { connection, server };
}

export function grantedConnectionIds(session: Record<string, unknown>): string[] {
  const raw = session.granted_connection_ids;
  return Array.isArray(raw) ? raw.map((id) => String(id)) : [];
}

export function connectionSummary(reach: ReachableConnection): Record<string, unknown> {
  return {
    id: String(reach.connection.id),
    server: {
      id: String(reach.server.id),
      slug: String(reach.server.slug),
      display_name: String(reach.server.display_name || reach.server.slug),
    },
    owner_scope: String(reach.connection.owner_scope),
    account_hint: String(reach.connection.account_hint ?? ""),
    status: String(reach.connection.status),
  };
}

// Proxies one read-only tool on an operator-granted connection. The result is
// redacted against that connection's stored credentials and byte-capped.
export async function callConnectionTool(args: {
  repo: Repositories;
  mcp: StudioMcpClient;
  reach: ReachableConnection;
  tool: string;
  arguments: Record<string, unknown>;
}): Promise<{ remote_name: string; name: string; content: string; truncated: boolean }> {
  const { connection, server } = args.reach;
  if (connection.status !== "connected") {
    throw new StudioUnprocessableError(`connection is ${String(connection.status)}`);
  }
  const slug = String(server.slug);
  const wanted = args.tool.trim();
  const listed = listedFromRows(await args.repo.listMcpTools(String(connection.id))).find(
    (tool) => tool.namespaced_name === wanted || tool.remote_name === wanted,
  );
  if (!listed) {
    throw new StudioUnprocessableError(`tool ${wanted} is not listed on this connection`);
  }
  if (!isReadOnlyRemote(slug, listed.remote_name, { readOnlyHint: listed.read_only_hint, verified: server.verified === true })) {
    throw new StudioUnprocessableError(`tool ${listed.namespaced_name} is not read-only; Studio proxies read-only tools`);
  }
  let redactions: Record<string, string>;
  try {
    redactions = tokenRedactions(
      decryptPayload(connection.ciphertext as Buffer, connection.nonce as Buffer),
      String(connection.id),
    );
  } catch {
    redactions = {};
  }
  let raw: string;
  try {
    raw = await args.mcp.call(args.repo, connection, server, listed.remote_name, args.arguments);
  } catch (error) {
    if (error instanceof McpError) {
      throw new StudioUnprocessableError(`${slug} call failed: ${error.message}`);
    }
    throw error;
  }
  const [content, truncated] = capBytes(redact(raw, redactions), STUDIO_TOOL_RESULT_MAX_BYTES);
  return { remote_name: listed.remote_name, name: listed.namespaced_name, content, truncated };
}
