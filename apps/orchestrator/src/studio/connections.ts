import { getMcpServer } from "../connectors/servers.js";
import { decryptPayload } from "../credentials/crypto.js";
import { jsonObj } from "../db/json.js";
import { McpError } from "../mcp/errors.js";
import { OPERATOR_CALLER, type McpPool } from "../mcp/pool.js";
import { callTool, connectionTools } from "../mcp/service.js";
import { tokenRedactions } from "../oauth/index.js";
import { redact } from "../secrets/index.js";
import { capBytes } from "../toolbox/output.js";
import { STUDIO_TOOL_RESULT_MAX_BYTES } from "./constants.js";
import { StudioError, StudioUnprocessableError } from "./errors.js";
import { getMcpConnection, type McpConnectionRow } from "../db/mcp.js";
import { getAgent } from "../db/agents.js";
import type { Queryable } from "../db/pg.js";
import type { LoadedConnector } from "../connectors/load.js";
import type { ConversationMessageRow } from "../db/conversations.js";
import type { ConversationMessageMetadata, MessagePayload, ToolMessage } from "../db/schema/index.js";
import type { StudioSessionRow } from "../db/studio.js";

export const STUDIO_CONNECTION_ACCESS_WIDGET = "studio_connection_access";

export type StudioLoginStatus = "pending" | "granted" | "declined";

/** A login request the coach made: its tool message and the connection it names. */
export type LoginRecord = {
  seq: number;
  connectionId: string;
  payload: ToolMessage;
  metadata: ConversationMessageMetadata;
};

function widgetOf(payload: MessagePayload): Record<string, unknown> | null {
  if (payload.role !== "tool") return null;
  try {
    return jsonObj(JSON.parse(payload.content)) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

/** The login request at a tool message seq; anything else there is not found. */
export function findLoginRecord(message: ConversationMessageRow | null, seq: number): LoginRecord {
  const payload = message?.payload;
  const widget = payload ? widgetOf(payload) : null;
  const connection = (jsonObj(widget?.connection) as Record<string, unknown> | null) ?? {};
  if (
    !message ||
    payload?.role !== "tool" ||
    widget?.widget !== STUDIO_CONNECTION_ACCESS_WIDGET ||
    typeof connection.id !== "string"
  ) {
    throw new StudioError(404, "login request not found");
  }
  return { seq, connectionId: connection.id, payload, metadata: message.metadata };
}

export function loginStatus(record: LoginRecord): StudioLoginStatus {
  return record.metadata.access_status ?? "pending";
}

/** The pool Studio calls a granted connection's tools through. */
export type StudioMcpClient = Pick<McpPool, "call" | "database">;

export type ReachableConnection = {
  connection: McpConnectionRow;
  server: LoadedConnector;
};

// A connection is in Studio's reach when an agent of the source guild could
// inherit it: platform, this organisation, this guild, or a live member.
export async function reachableConnection(
  db: Queryable,
  orgId: string,
  guildId: string,
  connectionId: string,
): Promise<ReachableConnection | null> {
  const connection = await getMcpConnection(db, connectionId);
  if (!connection) {
    return null;
  }
  const scope = connection.owner_scope;
  const ownerId = connection.owner_id === null || connection.owner_id === undefined ? null : String(connection.owner_id);
  let reachable = false;
  if (scope === "platform") {
    reachable = true;
  } else if (scope === "org") {
    reachable = ownerId === orgId;
  } else if (scope === "guild") {
    reachable = ownerId === guildId;
  } else if (scope === "agent" && ownerId) {
    const agent = await getAgent(db, ownerId);
    reachable = Boolean(agent && String(agent.guild_id) === guildId);
  }
  if (!reachable) {
    return null;
  }
  const server = await getMcpServer(db, connection.mcp_server_id);
  if (!server) {
    return null;
  }
  return { connection, server };
}

export function grantedConnectionIds(session: StudioSessionRow): string[] {
  const raw = session.granted_connection_ids;
  return Array.isArray(raw) ? raw.map((id) => String(id)) : [];
}

export function connectionSummary(reach: ReachableConnection): Record<string, unknown> {
  return {
    id: reach.connection.id,
    server: {
      id: String(reach.server.id),
      slug: String(reach.server.slug),
      display_name: String(reach.server.display_name || reach.server.slug),
    },
    owner_scope: reach.connection.owner_scope,
    account_hint: String(reach.connection.account_hint ?? ""),
    status: reach.connection.status,
  };
}

// Proxies one read-only tool on an operator-granted connection. The result is
// redacted against that connection's stored credentials and byte-capped.
export async function callConnectionTool(args: {
  db: Queryable;
  mcp: StudioMcpClient;
  reach: ReachableConnection;
  tool: string;
  arguments: Record<string, unknown>;
}): Promise<{ remote_name: string; name: string; content: string; truncated: boolean }> {
  const { connection, server } = args.reach;
  if (connection.status !== "connected") {
    throw new StudioUnprocessableError(`connection is ${connection.status}`);
  }
  const slug = server.slug;
  const wanted = args.tool.trim();
  const listed = (await connectionTools(args.db, connection, server)).find(
    (tool) => tool.namespaced_name === wanted || tool.remote_name === wanted,
  );
  if (!listed) {
    throw new StudioUnprocessableError(`tool ${wanted} is not listed on this connection`);
  }
  if (!listed.read_only) {
    throw new StudioUnprocessableError(`tool ${listed.namespaced_name} is not read-only; Studio proxies read-only tools`);
  }
  let redactions: Record<string, string>;
  try {
    redactions = tokenRedactions(
      decryptPayload(connection.ciphertext, connection.nonce),
      connection.id,
    );
  } catch {
    redactions = {};
  }
  let raw: string;
  try {
    raw = await callTool(args.mcp, {
      connectionId: connection.id,
      tool: listed.remote_name,
      arguments: args.arguments,
      caller: OPERATOR_CALLER,
    });
  } catch (error) {
    if (error instanceof McpError) {
      throw new StudioUnprocessableError(`${slug} call failed: ${error.message}`);
    }
    throw error;
  }
  const [content, truncated] = capBytes(redact(raw, redactions), STUDIO_TOOL_RESULT_MAX_BYTES);
  return { remote_name: listed.remote_name, name: listed.namespaced_name, content, truncated };
}
