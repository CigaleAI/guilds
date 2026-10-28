import { McpDisconnectedError, McpError } from "./errors.js";
import { mcpSchema } from "./tools.js";
import { markDisconnected, mcpDatabase } from "./database.js";
import type { McpPool, RemoteCall } from "./pool.js";
import { isReadOnlyRemote, type LoadedConnector } from "../connectors/servers.js";
import type { McpConnectionRow, McpToolRow } from "../db/mcp.js";
import type { Queryable } from "../db/pg.js";
import type { ToolInputSchema } from "../db/schema/index.js";

/**
 * A tool a connection offers: its names, what it does and takes, whether Studio may proxy it
 * (`isReadOnlyRemote`), and its schema for the model (`mcpSchema`).
 */
export type ConnectionTool = {
  namespaced_name: string;
  remote_name: string;
  description: string;
  input_schema: ToolInputSchema;
  read_only: boolean;
  schema: Record<string, unknown>;
};

/** A tool as a connection lists it: a stored row, or one its server's listing just returned. */
export type ListedConnectionTool = Pick<
  McpToolRow,
  "namespaced_name" | "remote_name" | "description" | "input_schema" | "read_only_hint"
>;

/** A call of a connection's tool: the connection, the tool's remote name, its arguments, and who calls it. */
export type McpToolCall = RemoteCall & { connectionId: string };

/**
 * Why a login stopped working. `unauthorised`: its server refuses the credentials it holds, or
 * it no longer holds any. `installation_gone`: GitHub no longer knows the installation it was
 * granted through. `never_connected`: the sign-in or key that would have made it a login failed,
 * and no login was there before.
 */
export type LoginFailure = "unauthorised" | "installation_gone" | "never_connected";

/** What retiring a login does to its row: a login that worked stays, disconnected, for its owner to reconnect. */
const RETIRED_AS: Record<LoginFailure, "disconnected" | "deleted"> = {
  unauthorised: "disconnected",
  installation_gone: "disconnected",
  never_connected: "deleted",
};

/** A listed tool as `server`'s connection offers it, with its read-only flag and its schema for the model. */
export function resolveConnectionTool(server: LoadedConnector, tool: ListedConnectionTool): ConnectionTool {
  return {
    namespaced_name: tool.namespaced_name,
    remote_name: tool.remote_name,
    description: tool.description,
    input_schema: tool.input_schema,
    read_only: isReadOnlyRemote(server, tool.remote_name, tool.read_only_hint),
    schema: mcpSchema(tool),
  };
}

/** The tools a connection to `server` last listed, as stored. */
export async function connectionTools(
  db: Queryable,
  connection: McpConnectionRow,
  server: LoadedConnector,
): Promise<ConnectionTool[]> {
  const rows = await mcpDatabase(db).listMcpTools(connection.id);
  return rows.map((row) => resolveConnectionTool(server, row));
}

/**
 * The tools a connection to `server` lists now: synced through the pool, which lists them from
 * the server again once its last listing is older than the pool's tool TTL. A listing that fails
 * answers the tools as stored.
 */
export async function currentTools(
  pool: Pick<McpPool, "syncTools" | "database">,
  connection: McpConnectionRow,
  server: LoadedConnector,
): Promise<ConnectionTool[]> {
  try {
    return (await pool.syncTools(connection, server)).map((tool) => resolveConnectionTool(server, tool));
  } catch {
    const rows = await pool.database.listMcpTools(connection.id);
    return rows.map((row) => resolveConnectionTool(server, row));
  }
}

/**
 * Calls a tool on a connection through the pool, and answers its result as text. A connection
 * that is gone throws `McpDisconnectedError`; a connector that is gone throws `McpError`.
 */
export async function callTool(pool: Pick<McpPool, "call" | "database">, call: McpToolCall): Promise<string> {
  const connection = await pool.database.getMcpConnection(call.connectionId);
  if (connection === null) {
    throw new McpDisconnectedError("connection not found");
  }
  const server = await pool.database.getMcpServer(connection.mcp_server_id);
  if (server === null) {
    throw new McpError("mcp server not found");
  }
  return pool.call(connection, server, { tool: call.tool, arguments: call.arguments, caller: call.caller });
}

/**
 * Retires a login that stopped working: disconnected, or deleted when it never connected, as
 * `failure` says, and forgotten by the pool when the box has one.
 */
export async function retireLogin(
  pool: Pick<McpPool, "forget"> | null,
  db: Queryable,
  connection: McpConnectionRow,
  failure: LoginFailure,
): Promise<void> {
  const database = mcpDatabase(db);
  if (RETIRED_AS[failure] === "deleted") {
    await database.deleteMcpConnection(connection.id);
  } else {
    await markDisconnected(database, connection);
  }
  pool?.forget(connection.id);
}
