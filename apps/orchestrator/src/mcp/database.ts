import { getMcpServer, saveOauthClient } from "../connectors/servers.js";
import { insertBindingIfAbsent } from "../db/bindings.js";
import { countConnectorCalls, recordConnectorCall } from "../db/connectors.js";
import {
  deleteMcpConnection,
  getMcpConnection,
  listMcpTools,
  replaceMcpTools,
  saveMcpConnection,
  type McpConnectionRow,
} from "../db/mcp.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import { githubRepositoryRecorder } from "../github/tokens.js";

/** The db/ functions MCP reads logins and their tools, meters calls, and refreshes and retires logins through, on `db`. */
export function mcpDatabase(db: Queryable) {
  return {
    ...githubRepositoryRecorder(db),
    getMcpConnection: bindQuery(db, getMcpConnection),
    getMcpServer: bindQuery(db, getMcpServer),
    listMcpTools: bindQuery(db, listMcpTools),
    countConnectorCalls: bindQuery(db, countConnectorCalls),
    recordConnectorCall: bindQuery(db, recordConnectorCall),
    replaceMcpTools: bindQuery(db, replaceMcpTools),
    insertBindingIfAbsent: bindQuery(db, insertBindingIfAbsent),
    saveMcpConnection: bindQuery(db, saveMcpConnection),
    deleteMcpConnection: bindQuery(db, deleteMcpConnection),
    saveOauthClient: bindQuery(db, saveOauthClient),
  };
}

export type McpDatabase = ReturnType<typeof mcpDatabase>;

export async function markDisconnected(db: Pick<McpDatabase, "saveMcpConnection">, connection: McpConnectionRow): Promise<void> {
  await db.saveMcpConnection(
    connection.id,
    {
      ciphertext: connection.ciphertext,
      nonce: connection.nonce,
      status: "disconnected",
      accountHint: String(connection.account_hint ?? ""),
      oauthState: null,
    },
    new Date(),
  );
}
