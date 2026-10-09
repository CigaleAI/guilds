import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/db/client.js";
import { Repositories } from "../../src/db/repositories.js";
import { NotesStore } from "../../src/notes/store.js";
import { Scripts } from "../../src/scripts/catalog.js";
import { Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { limitedPolicy } from "../helpers/policy.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const dbName = uniqueDbName("agent_platform_org_connectors");
const JSON_HEADERS = { "content-type": "application/json" };
const HOME = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("an organisation adds remote servers of its own that no other organisation sees", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(await createIsolatedDatabase(dbName));
  const notes = new NotesStore(tempDir("guilds-org-connectors-notes-"), templatesRoot(), "notes");
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool);
  const app = await buildApp(database, {
    repo,
    notes,
    scripts: new Scripts(repo),
    schedules: new Schedules(repo, notes),
    policy: limitedPolicy({ maxMcpServers: 2 }),
    masterKey: Buffer.from(HEX_MASTER_KEY, "hex"),
  });
  const other = await repo.insertUser("user_other", "other", new Date(), null, "other@example.com");
  await repo.insertOrg("org_other", "other team", "other-team", String(other.id), new Date());
  const OTHER = { "X-Guilds-User": String(other.id), "X-Guilds-Org": "org_other" };
  const member = await repo.insertUser("user_member", "member", new Date(), null, "member@example.com");
  await repo.insertMember("org_home", String(member.id), "member", new Date());
  const add = (headers: Record<string, string>, org: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/api/orgs/${org}/mcp/servers`,
      headers: { ...headers, ...JSON_HEADERS },
      payload,
    });
  try {
    const byMember = await add(
      { "X-Guilds-User": String(member.id), "X-Guilds-Org": "org_home" },
      "org_home",
      { slug: "crm", url: "https://mcp.crm.example/mcp" },
    );
    assert.equal(byMember.statusCode, 404);

    const created = await add(HOME, "org_home", { slug: "crm", url: "https://mcp.crm.example/mcp", auth: "token" });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().owner_org_id, "org_home");
    assert.equal(created.json().tool_prefix, "crm");
    const crmId = String(created.json().id);

    assert.equal((await add(HOME, "org_home", { slug: "notion", url: "https://mcp.example.com/mcp" })).statusCode, 409);
    assert.match((await add(HOME, "org_home", { slug: "notion", url: "https://mcp.example.com/mcp" })).json().detail, /platform/);
    assert.equal((await add(HOME, "org_home", { slug: "crm", url: "https://mcp.example.com/mcp" })).statusCode, 409);
    assert.equal((await add(HOME, "org_home", { slug: "inside", url: "https://10.0.0.8/mcp" })).statusCode, 422);
    assert.equal(
      (await add(HOME, "org_home", { slug: "own_oauth", url: "https://mcp.example.com/mcp", auth: "oauth", oauth_strategy: "configured" })).statusCode,
      422,
    );

    const sameSlug = await add(OTHER, "org_other", { slug: "crm", url: "https://mcp.othercrm.example/mcp" });
    assert.equal(sameSlug.statusCode, 201, sameSlug.body);
    assert.equal(sameSlug.json().tool_prefix, "crm2");

    const adminCollision = await app.inject({
      method: "POST",
      url: "/api/admin/mcp/servers",
      headers: { ...HOME, ...JSON_HEADERS },
      payload: { slug: "crm", url: "https://mcp.example.com/mcp" },
    });
    assert.equal(adminCollision.statusCode, 409);
    assert.match(adminCollision.json().detail, /organisation/);

    assert.equal((await add(HOME, "org_home", { slug: "wiki", url: "https://mcp.wiki.example/mcp" })).statusCode, 201);
    const capped = await add(HOME, "org_home", { slug: "third", url: "https://mcp.third.example/mcp" });
    assert.equal(capped.statusCode, 409);
    assert.match(capped.json().detail, /limit reached: MCP servers/);

    const homeList = await app.inject({ method: "GET", url: "/api/mcp/servers", headers: HOME });
    const homeIds = (homeList.json().servers as Array<{ id: string }>).map((row) => row.id);
    assert.ok(homeIds.includes(crmId));
    assert.ok(!homeIds.includes(String(sameSlug.json().id)));
    assert.ok(homeIds.includes("mcp_notion"));

    const access = await app.inject({ method: "GET", url: "/api/access", headers: HOME });
    const card = (access.json().mcp as Array<Record<string, unknown>>).find((row) => row.id === crmId);
    assert.equal(card?.org_owned, true);

    const otherAccess = await app.inject({ method: "GET", url: "/api/access", headers: OTHER });
    assert.ok(!(otherAccess.json().mcp as Array<{ id: string }>).some((row) => row.id === crmId));

    const foreignConnect = await app.inject({
      method: "POST",
      url: "/api/mcp/connections",
      headers: { ...OTHER, ...JSON_HEADERS },
      payload: { mcp_server_id: crmId, owner_scope: "org", owner_id: "org_other", token: "k" },
    });
    assert.equal(foreignConnect.statusCode, 404);
    const foreignPatch = await app.inject({
      method: "PATCH",
      url: `/api/orgs/org_other/mcp/servers/${crmId}`,
      headers: { ...OTHER, ...JSON_HEADERS },
      payload: { enabled: false },
    });
    assert.equal(foreignPatch.statusCode, 404);
    const foreignBinding = await app.inject({
      method: "PUT",
      url: "/api/bindings",
      headers: { ...OTHER, ...JSON_HEADERS },
      payload: { catalog_kind: "mcp", catalog_id: crmId, scope: "org", scope_id: "org_other", enabled: true },
    });
    assert.equal(foreignBinding.statusCode, 404);

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/orgs/org_home/mcp/servers/${crmId}`,
      headers: { ...HOME, ...JSON_HEADERS },
      payload: { display_name: "Acme CRM" },
    });
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.equal(renamed.json().display_name, "Acme CRM");

    const removed = await app.inject({ method: "DELETE", url: `/api/orgs/org_home/mcp/servers/${crmId}`, headers: HOME });
    assert.equal(removed.statusCode, 204);
    assert.equal(await repo.getMcpServer(crmId), null);
  } finally {
    await app.close();
    await database.close();
  }
});
