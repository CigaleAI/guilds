import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/db/client.js";
import { Repositories } from "../../src/db/repositories.js";
import { setInstanceKeys } from "../../src/instance/integrations.js";
import { NotesStore } from "../../src/notes/store.js";
import { Scripts } from "../../src/scripts/catalog.js";
import { Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const OWNER = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const MEMBER = { "X-Guilds-User": "user_member", "X-Guilds-Org": "org_home" };

const dbName = uniqueDbName("agent_platform_instance_admin");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("the instance is administered by the seed organisation's owners, or by whom an edition says", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(await createIsolatedDatabase(dbName));
  const notes = new NotesStore(tempDir("guilds-instance-admin-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool);
  const member = await repo.insertUser("user_member", "member", new Date(), null, "member@example.com");
  await repo.insertMember("org_home", String(member.id), "member", new Date());
  const deps = { repo, notes, scripts: new Scripts(repo), schedules: new Schedules(repo) };
  const core = await buildApp(database, deps);
  const overridden = await buildApp(database, {
    ...deps,
    instanceAdmin: async (userId: string) => userId === "user_member",
  });
  const status = async (app: typeof core, url: string, headers: Record<string, string>) =>
    (await app.inject({ method: "GET", url, headers })).statusCode;
  const flag = async (app: typeof core, headers: Record<string, string>) =>
    (await app.inject({ method: "GET", url: "/api/auth/me", headers })).json().platform_admin;
  const putKey = async (app: typeof core, headers: Record<string, string>) =>
    (
      await app.inject({
        method: "PUT",
        url: "/api/admin/instance/keys/web-search",
        headers: { ...headers, "content-type": "application/json" },
        payload: { values: { api_key: "tvly-matrix" } },
      })
    ).statusCode;

  try {
    // Core's rule: an owner of the seed organisation.
    assert.equal(await flag(core, OWNER), true);
    assert.equal(await flag(core, MEMBER), false);
    for (const url of ["/api/admin/mcp/servers", "/api/platform"]) {
      assert.equal(await status(core, url, OWNER), 200, url);
      assert.equal(await status(core, url, MEMBER), 404, url);
    }
    assert.equal(await putKey(core, OWNER), 200);
    assert.equal(await putKey(core, MEMBER), 404);

    // An edition's rule replaces it everywhere it is asked.
    assert.equal(await flag(overridden, OWNER), false);
    assert.equal(await flag(overridden, MEMBER), true);
    for (const url of ["/api/admin/mcp/servers", "/api/platform"]) {
      assert.equal(await status(overridden, url, OWNER), 404, url);
      assert.equal(await status(overridden, url, MEMBER), 200, url);
    }
    assert.equal(await putKey(overridden, OWNER), 404);
    assert.equal(await putKey(overridden, MEMBER), 200);

    // The profile route is core's: a member renames themselves without any extension.
    const renamed = await core.inject({
      method: "PATCH",
      url: "/api/auth/me",
      headers: { ...MEMBER, "content-type": "application/json" },
      payload: { name: "member-two" },
    });
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.equal(renamed.json().name, "member-two");
    assert.equal(renamed.json().platform_admin, false);
  } finally {
    setInstanceKeys({});
    await core.close();
    await overridden.close();
    await database.close();
  }
});
