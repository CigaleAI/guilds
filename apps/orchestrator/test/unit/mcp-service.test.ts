import assert from "node:assert/strict";
import { test } from "node:test";
import { McpDisconnectedError, McpError } from "../../src/mcp/errors.js";
import { mcpSchema, type ListedTool } from "../../src/mcp/tools.js";
import { OPERATOR_CALLER, type RemoteCall } from "../../src/mcp/pool.js";
import { callTool, currentTools, resolveConnectionTool } from "../../src/mcp/service.js";
import { MemoryMcpDatabase, storedTool } from "../helpers/mcp-database.js";
import { connectionRow, serverRow } from "../helpers/servers.js";

const NOTION = serverRow("notion", { id: "mcp_notion" });
const SCHEMA = { type: "object", properties: { query: { type: "string" } } };

function listed(remoteName: string): ListedTool {
  return { remote_name: remoteName, namespaced_name: `notion_${remoteName}`, description: `Does ${remoteName}`, input_schema: SCHEMA, read_only_hint: null, destructive_hint: null };
}

/** A database whose login `conn_1` last listed `remoteNames`. */
function storedListing(...remoteNames: string[]): MemoryMcpDatabase {
  const database = new MemoryMcpDatabase();
  database.tools = remoteNames.map((name) => storedTool("conn_1", listed(name)));
  return database;
}

test("resolves_a_listed_tool_with_its_read_only_flag_and_model_schema", () => {
  const search = resolveConnectionTool(NOTION, listed("notion-search"));
  assert.equal(search.read_only, true);
  assert.equal(search.namespaced_name, "notion_notion-search");
  assert.deepEqual(search.input_schema, SCHEMA);
  assert.deepEqual(search.schema, mcpSchema(listed("notion-search")));
  assert.equal(resolveConnectionTool(NOTION, listed("notion-create-pages")).read_only, false);
});

test("answers_the_tools_the_pool_lists_now", async () => {
  const pool = { database: storedListing("notion-create-pages"), syncTools: async () => [listed("notion-search")] };
  const tools = await currentTools(pool, connectionRow({ id: "conn_1" }), NOTION);
  assert.deepEqual(tools.map((tool) => tool.remote_name), ["notion-search"]);
});

test("answers_the_stored_tools_when_the_listing_fails", async () => {
  const pool = {
    database: storedListing("notion-create-pages"),
    syncTools: async (): Promise<ListedTool[]> => {
      throw new McpError("mcp 503", 503);
    },
  };
  const tools = await currentTools(pool, connectionRow({ id: "conn_1" }), NOTION);
  assert.deepEqual(tools.map((tool) => [tool.remote_name, tool.read_only]), [["notion-create-pages", false]]);
});

/** A pool whose database holds the logins and connectors given, keeping each remote call it makes. */
function callingPool(rows: { connection: boolean; server: boolean }) {
  const database = new MemoryMcpDatabase();
  database.connections = rows.connection ? [connectionRow({ id: "conn_1", mcp_server_id: "mcp_notion" })] : [];
  database.servers = rows.server ? [NOTION] : [];
  const calls: Array<{ connectionId: string; serverId: string; call: RemoteCall }> = [];
  const pool = {
    database,
    call: async (connection: { id: string }, server: { id: string }, call: RemoteCall) => {
      calls.push({ connectionId: connection.id, serverId: server.id, call });
      return "found";
    },
  };
  return { pool, calls };
}

const SEARCH = { connectionId: "conn_1", tool: "notion-search", arguments: { query: "roadmap" }, caller: OPERATOR_CALLER };

test("calls_a_tool_on_the_connection_and_server_its_id_names", async () => {
  const { pool, calls } = callingPool({ connection: true, server: true });
  assert.equal(await callTool(pool, SEARCH), "found");
  assert.deepEqual(calls, [
    {
      connectionId: "conn_1",
      serverId: "mcp_notion",
      call: { tool: "notion-search", arguments: { query: "roadmap" }, caller: OPERATOR_CALLER },
    },
  ]);
});

test("throws_disconnected_when_the_connection_is_gone", async () => {
  const { pool, calls } = callingPool({ connection: false, server: true });
  await assert.rejects(callTool(pool, SEARCH), McpDisconnectedError);
  assert.deepEqual(calls, []);
});

test("throws_an_mcp_error_when_the_connector_is_gone", async () => {
  const { pool, calls } = callingPool({ connection: true, server: false });
  await assert.rejects(
    callTool(pool, SEARCH),
    (error: unknown) => error instanceof McpError && !(error instanceof McpDisconnectedError) && /server not found/.test(error.message),
  );
  assert.deepEqual(calls, []);
});
