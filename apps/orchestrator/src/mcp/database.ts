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
import { githubRepositoryRecorder, type GithubRepositoryRecorder } from "../github/tokens.js";

/** A db/ function with its connection bound. */
type BoundQuery<F> = F extends (db: Queryable, ...args: infer A) => infer R ? (...args: A) => R : never;

/** The db/ functions MCP reads logins and their tools, meters calls, and refreshes and retires logins through. */
export type McpDatabase = GithubRepositoryRecorder & {
  getMcpConnection: BoundQuery<typeof getMcpConnection>;
  getMcpServer: BoundQuery<typeof getMcpServer>;
  listMcpTools: BoundQuery<typeof listMcpTools>;
  countConnectorCalls: BoundQuery<typeof countConnectorCalls>;
  recordConnectorCall: BoundQuery<typeof recordConnectorCall>;
  replaceMcpTools: BoundQuery<typeof replaceMcpTools>;
  insertBindingIfAbsent: BoundQuery<typeof insertBindingIfAbsent>;
  saveMcpConnection: BoundQuery<typeof saveMcpConnection>;
  deleteMcpConnection: BoundQuery<typeof deleteMcpConnection>;
  saveOauthClient: BoundQuery<typeof saveOauthClient>;
};

/** MCP's db/ functions on `db`. */
export function mcpDatabase(db: Queryable): McpDatabase {
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
