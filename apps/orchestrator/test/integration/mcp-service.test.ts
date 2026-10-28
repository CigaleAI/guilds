import assert from "node:assert/strict";
import { after, test } from "node:test";
import { getMcpServerBySlug } from "../../src/connectors/servers.js";
import { connectMcp, getMcpConnection, replaceMcpTools, type McpConnectionRow } from "../../src/db/mcp.js";
import { insertOrg } from "../../src/db/orgs.js";
import { connectionTools, retireLogin, type LoginFailure } from "../../src/mcp/service.js";
import { connect } from "../../src/seed/connect.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const dbName = uniqueDbName("agent_platform_mcp_service");
const opened = createIsolatedDatabase(dbName).then((url) => connect(url));

after(async () => {
  await (await opened).close();
  await dropIsolatedDatabase(dbName);
});

/** A connected Notion login of a new organisation, `owner`. */
async function notionLogin(owner: string): Promise<McpConnectionRow> {
  const db = (await opened).pool;
  const server = (await getMcpServerBySlug(db, "notion"))!;
  await insertOrg(db, { orgId: owner, name: owner, slug: owner.replaceAll("_", "-"), userId: "user_operator" }, new Date());
  return connectMcp(
    db,
    {
      connectionId: `conn_${owner}`,
      bindingId: `bind_${owner}`,
      serverId: server.id,
      ownerScope: "org",
      ownerId: owner,
      ciphertext: Buffer.from([1]),
      nonce: Buffer.from([2]),
      status: "connected",
      accountHint: owner,
    },
    new Date(),
  );
}

/** The login of `owner` once retired for `failure`, as stored; null when it is gone. The pool's forgotten ids gather in `forgotten`. */
async function retired(owner: string, failure: LoginFailure, forgotten: string[] = []): Promise<McpConnectionRow | null> {
  const db = (await opened).pool;
  const connection = await notionLogin(owner);
  await retireLogin({ forget: (connectionId) => forgotten.push(connectionId) }, db, connection, failure);
  return getMcpConnection(db, connection.id);
}

test("reads_a_connections_tools_as_stored_with_their_read_only_flag", { timeout: 60_000 }, async () => {
  const db = (await opened).pool;
  const server = (await getMcpServerBySlug(db, "notion"))!;
  const connection = await notionLogin("org_tools");
  const schema = { type: "object", properties: { query: { type: "string" } } };
  await replaceMcpTools(
    db,
    connection.id,
    [
      { remote_name: "notion-search", namespaced_name: "notion_notion-search", description: "Search", input_schema: schema },
      { remote_name: "notion-create-pages", namespaced_name: "notion_notion-create-pages", description: "Create", input_schema: schema },
    ],
    new Date(),
  );
  const tools = await connectionTools(db, connection, server);
  assert.deepEqual(
    tools.map((tool) => [tool.remote_name, tool.read_only]),
    [["notion-create-pages", false], ["notion-search", true]],
  );
});

test("retires_login_as_disconnected_when_unauthorised", { timeout: 60_000 }, async () => {
  const forgotten: string[] = [];
  const stored = await retired("org_unauthorised", "unauthorised", forgotten);
  assert.equal(stored?.status, "disconnected");
  assert.equal(stored?.account_hint, "org_unauthorised");
  assert.deepEqual(forgotten, ["conn_org_unauthorised"]);
});

test("retires_login_as_disconnected_when_its_installation_is_gone", { timeout: 60_000 }, async () => {
  assert.equal((await retired("org_gone", "installation_gone"))?.status, "disconnected");
});

test("retires_login_by_deleting_it_when_it_never_connected", { timeout: 60_000 }, async () => {
  const forgotten: string[] = [];
  assert.equal(await retired("org_new", "never_connected", forgotten), null);
  assert.deepEqual(forgotten, ["conn_org_new"]);
});

test("retires_login_without_a_pool_on_a_box_that_calls_no_connector", { timeout: 60_000 }, async () => {
  const db = (await opened).pool;
  const connection = await notionLogin("org_alone");
  await retireLogin(null, db, connection, "unauthorised");
  assert.equal((await getMcpConnection(db, connection.id))?.status, "disconnected");
});
