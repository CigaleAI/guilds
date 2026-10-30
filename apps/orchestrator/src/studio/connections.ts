import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { getMcpServer, type LoadedConnector } from "../connectors/servers.js";
import { McpError } from "../mcp/errors.js";
import { OPERATOR_CALLER, type McpPool } from "../mcp/pool.js";
import { callTool, connectionTools } from "../mcp/service.js";
import { storedTokenRedactions } from "../oauth/index.js";
import { redact } from "../secrets/index.js";
import { capBytes } from "../lib/bytes.js";
import { STUDIO_TOOL_RESULT_MAX_BYTES } from "./constants.js";
import { StudioConflictError, StudioNotFoundError, StudioUnprocessableError } from "./errors.js";
import { projectGuildConnections, type PreviewDeps } from "./preview.js";
import { withLockedSession } from "./session-lock.js";
import type { LiveStudioSession } from "./index.js";
import { getMcpConnection, type McpConnectionRow } from "../db/mcp.js";
import { getAgent } from "../db/agents.js";
import type { Queryable } from "../db/pg.js";
import {
  getConversationMessage,
  updateConversationMessage,
  type ConversationMessageRow,
} from "../db/conversations.js";
import type { ConversationMessageMetadata, MessagePayload, ToolMessage } from "../db/schema/index.js";
import { updateStudioSession, type StudioSessionRow } from "../db/studio.js";
import type { UserRow } from "../db/users.js";

export const STUDIO_CONNECTION_ACCESS_WIDGET = "studio_connection_access";

export type StudioLoginStatus = "pending" | "granted" | "declined";

/** A login request the coach made: its tool message and the connection it names. */
export type LoginRecord = {
  seq: number;
  connectionId: string;
  payload: ToolMessage;
  metadata: ConversationMessageMetadata;
};

/** What answering a login request reads from its widget: the connection it asks to read through. */
const LoginRequestWidgetSchema = Type.Object({
  widget: Type.Literal(STUDIO_CONNECTION_ACCESS_WIDGET),
  connection: Type.Object({ id: Type.String() }),
});

type LoginRequestWidget = Static<typeof LoginRequestWidgetSchema>;

/** The login request a message holds, or null when it holds none. */
function parseLoginWidget(payload: MessagePayload): LoginRequestWidget | null {
  if (payload.role !== "tool") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.content);
  } catch {
    return null;
  }
  return Value.Check(LoginRequestWidgetSchema, parsed) ? parsed : null;
}

/** The login request at a tool message seq; anything else there is not found. */
export function findLoginRecord(message: ConversationMessageRow | null, seq: number): LoginRecord {
  const payload = message?.payload;
  const widget = payload ? parseLoginWidget(payload) : null;
  if (!message || payload?.role !== "tool" || !widget) {
    throw new StudioNotFoundError("login request not found");
  }
  return { seq, connectionId: widget.connection.id, payload, metadata: message.metadata };
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
  const redactions = storedTokenRedactions(connection);
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

/** The source guild's logins, each with whether the session's coach holds a grant on it. */
export async function listSessionConnections(
  preview: PreviewDeps,
  session: StudioSessionRow,
): Promise<Array<Record<string, unknown>>> {
  if (!session.source_guild_id) {
    return [];
  }
  const granted = new Set(grantedConnectionIds(session));
  const projected = await projectGuildConnections(
    preview,
    session.org_id,
    session.source_guild_id,
  );
  return projected.map((connection) => ({
    id: connection.id,
    server: connection.server,
    owner_scope: connection.owner_scope,
    owner_id: connection.owner_id,
    account_hint: connection.account_hint,
    status: connection.status,
    granted: granted.has(connection.id),
    readable_tools: connection.tools.filter((tool) => tool.read_only).map((tool) => tool.name),
    tool_count: connection.tools.length,
  }));
}

/** Lets the coach use one login of the source guild in this session; the session row as it stands after. */
export async function grantSessionConnection(
  db: Queryable,
  session: StudioSessionRow,
  connectionId: string,
): Promise<StudioSessionRow> {
  const next = await grantedWith(db, session, connectionId);
  const updated = await updateStudioSession(
    db,
    session.id,
    { granted_connection_ids: next },
    new Date(),
  );
  return updated ?? { ...session, granted_connection_ids: next };
}

/** Takes one login back from the coach in this session; the session row as it stands after. */
export async function withdrawSessionConnection(
  db: Queryable,
  session: StudioSessionRow,
  connectionId: string,
): Promise<StudioSessionRow> {
  assertTakesGrants(session);
  const next = grantedConnectionIds(session).filter((id) => id !== connectionId);
  const updated = await updateStudioSession(
    db,
    session.id,
    { granted_connection_ids: next },
    new Date(),
  );
  return updated ?? { ...session, granted_connection_ids: next };
}

/** A session takes grants while it is active and its source guild is there. */
export function assertTakesGrants(session: StudioSessionRow): asserts session is LiveStudioSession {
  if (session.status !== "active") {
    throw new StudioConflictError("session is not active");
  }
  if (!session.source_guild_id) {
    throw new StudioUnprocessableError("source guild is gone");
  }
}

// The session's granted logins with one more. A grant must name a
// connected login the source guild can reach.
export async function grantedWith(
  db: Queryable,
  session: StudioSessionRow,
  connectionId: string,
): Promise<string[]> {
  assertTakesGrants(session);
  const current = grantedConnectionIds(session);
  const reach = await reachableConnection(
    db,
    session.org_id,
    session.source_guild_id,
    connectionId,
  );
  if (!reach) {
    throw new StudioUnprocessableError("connection is not reachable from the source guild");
  }
  if (reach.connection.status !== "connected") {
    throw new StudioUnprocessableError(`connection is ${String(reach.connection.status)}`);
  }
  return current.includes(connectionId) ? current : [...current, connectionId];
}

/** An operator's answer to the login request at `seq` of a session's log. */
export type LoginAnswer = {
  user: UserRow;
  seq: number;
  decision: "grant" | "decline";
};

// Grant or decline one login request from the Studio log. The answer and
// who gave it are kept on the request's tool message; a grant also adds the
// login to the session. The session lock serialises answers.
export async function answerLoginRequest(
  db: Queryable,
  session: LiveStudioSession,
  { user, seq, decision }: LoginAnswer,
): Promise<StudioSessionRow> {
  const sessionId = session.id;
  return withLockedSession(db, sessionId, async (client, locked) => {
    const record = findLoginRecord(await getConversationMessage(client, "studio", sessionId, seq), seq);
    const status = loginStatus(record);
    if (status !== "pending") {
      throw new StudioConflictError(`login request is already ${status}`);
    }
    const now = new Date();
    await updateConversationMessage(
      client,
      "studio",
      { session_id: sessionId, seq, payload: record.payload, metadata: {
      ...record.metadata,
      access_status: decision === "grant" ? "granted" : "declined",
      access_resolved_at: now.toISOString(),
      resolved_by_user_id: user.id ?? null,
    } },
    );
    if (decision === "decline") {
      return locked;
    }
    const next = await grantedWith(db, locked, record.connectionId);
    return (await updateStudioSession(client, sessionId, { granted_connection_ids: next }, now)) ?? locked;
  });
}
