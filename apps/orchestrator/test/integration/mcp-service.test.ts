import assert from "node:assert/strict";
import { after, test } from "node:test";
import { getMcpServerBySlug } from "../../src/connectors/servers.js";
import { countConnectorCalls, recordConnectorCall } from "../../src/db/connectors.js";
import { insertGuild, listGuildRepositories } from "../../src/db/guilds.js";
import {
  connectMcp,
  getMcpConnection,
  recordGithubRepository,
  replaceConnectionGuildRepositories,
  replaceMcpTools,
  type McpConnectionRow,
} from "../../src/db/mcp.js";
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

test("counts_an_organisations_calls_on_a_connector_per_month", { timeout: 60_000 }, async () => {
  const db = (await opened).pool;
  const connectorId = (await notionLogin("org_metered")).mcp_server_id;
  const calls = { org_id: "org_metered", connector_id: connectorId, month: "2026-03" };
  await recordConnectorCall(db, calls, new Date());
  await recordConnectorCall(db, calls, new Date());
  assert.equal(await countConnectorCalls(db, "org_metered", connectorId, "2026-03"), 2);
  assert.equal(await countConnectorCalls(db, "org_metered", connectorId, "2026-04"), 0);
});

test("records_githubs_id_and_url_for_a_repository_a_guilds_login_lists", { timeout: 60_000 }, async () => {
  const db = (await opened).pool;
  const server = await getMcpServerBySlug(db, "github");
  assert.ok(server);
  const now = new Date();
  await insertOrg(db, { orgId: "org_git", name: "org_git", slug: "org-git", userId: "user_operator" }, now);
  await insertGuild(db, { guildId: "guild_git", name: "git", orgId: "org_git" }, now);
  const listed = { name: "site", url: "https://github.com/acme/old-site", default_branch: "main" };
  const login = await connectMcp(
    db,
    {
      connectionId: "conn_git",
      bindingId: "bind_git",
      serverId: server.id,
      ownerScope: "guild",
      ownerId: "guild_git",
      ciphertext: Buffer.from([1]),
      nonce: Buffer.from([2]),
      status: "connected",
      accountHint: "acme",
      settings: { repositories: [listed] },
    },
    now,
  );
  await replaceConnectionGuildRepositories(
    db,
    { connection_id: login.id, guild_id: "guild_git" },
    [{ id: "repo_site", name: "site", url: listed.url, defaultBranch: "main", githubId: null }],
    now,
  );
  const current = "https://github.com/acme/site";
  await recordGithubRepository(db, login.id, { name: "site", github_id: 102, url: current }, now);
  const repositories = await listGuildRepositories(db, "guild_git");
  assert.deepEqual(
    repositories.map((row) => [row.name, row.github_id, row.url, row.connection_id]),
    [["site", 102, current, login.id]],
  );
  assert.deepEqual((await getMcpConnection(db, login.id))?.settings.repositories, [
    { ...listed, github_id: 102, url: current },
  ]);
});
