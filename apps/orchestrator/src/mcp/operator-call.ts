import { asBuffer, decryptPayload } from "../credentials/crypto.js";
import { tokenRedactions } from "../oauth/index.js";
import { redact } from "../secrets/index.js";
import { capBytes } from "../toolbox/output.js";
import { McpDisconnectedError, McpError } from "./errors.js";
import { OPERATOR_CALLER, type McpPool } from "./pool.js";
import { resolveConnectionTool } from "./service.js";
import type { LoadedConnector } from "../connectors/load.js";
import type { McpConnectionRow } from "../db/mcp.js";

export const OPERATOR_TOOL_RESULT_MAX_BYTES = 64 * 1024;

export class OperatorCallError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "OperatorCallError";
    this.status = status;
  }
}

/** Calls one listed tool on a connected login the operator can see. Results are redacted and capped. */
export async function callOwnedConnectionTool(args: {
  mcp: Pick<McpPool, "call" | "database">;
  connection: McpConnectionRow;
  server: LoadedConnector;
  tool: string;
  arguments: Record<string, unknown>;
  masterKey?: Buffer;
}): Promise<{ remote_name: string; name: string; content: string; truncated: boolean }> {
  const { connection, server } = args;
  if (connection.status !== "connected") {
    throw new OperatorCallError(409, `connection is ${connection.status}`);
  }
  const wanted = args.tool.trim();
  if (!wanted) {
    throw new OperatorCallError(422, "tool is required");
  }
  const listed = (await args.mcp.database.listMcpTools(connection.id))
    .map((row) => resolveConnectionTool(server, row))
    .find((tool) => tool.namespaced_name === wanted || tool.remote_name === wanted);
  if (!listed) {
    throw new OperatorCallError(422, `tool ${wanted} is not listed on this connection`);
  }
  let redactions: Record<string, string>;
  try {
    redactions = tokenRedactions(
      decryptPayload(asBuffer(connection.ciphertext), asBuffer(connection.nonce), args.masterKey),
      connection.id,
    );
  } catch {
    redactions = {};
  }
  let raw: string;
  try {
    raw = await args.mcp.call(connection, server, {
      tool: listed.remote_name,
      arguments: args.arguments,
      caller: OPERATOR_CALLER,
    });
  } catch (error) {
    if (error instanceof McpDisconnectedError) {
      throw new OperatorCallError(409, error.message);
    }
    if (error instanceof McpError) {
      const rejected = error.status === 401 || error.status === 403;
      throw new OperatorCallError(
        rejected ? 422 : 502,
        rejected ? "api key was rejected" : `${server.slug} call failed: ${error.message}`,
      );
    }
    throw error;
  }
  const [content, truncated] = capBytes(redact(raw, redactions), OPERATOR_TOOL_RESULT_MAX_BYTES);
  return { remote_name: listed.remote_name, name: listed.namespaced_name, content, truncated };
}
