import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/seed/connect.js";
import { setInstanceKeys } from "../../src/instance/integrations.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { insertUser } from "../../src/db/users.js";
import { insertMember } from "../../src/db/orgs.js";

const OWNER = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const MEMBER = { "X-Guilds-User": "user_member", "X-Guilds-Org": "org_home" };
const KEY = "tvly-instance-test-key";

const dbName = uniqueDbName("agent_platform_instance");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

type Status = {
  id: string;
  state: string;
  source: string;
  fields: Array<{ name: string; set: boolean }>;
  updated_at: string | null;
  set_by: string | null;
};

test("the instance descriptor lists integrations and their state, never a key", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  setInstanceKeys({});
  const database = await connect(await createIsolatedDatabase(dbName));
  const notes = new NotesStore(tempDir("guilds-instance-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  const member = await insertUser(db, { userId: "user_member", name: "member", image: null, email: "member@example.com" }, new Date());
  await insertMember(
    db,
    { org_id: "org_home", user_id: String(member.id), role: "member" },
    new Date(),
  );
  const deps = { db, notes, scripts: agentScripts(db), schedules: agentSchedules(db) };
  const core = await buildApp(database, deps);
  const describe = async (headers: Record<string, string>) => {
    const response = await core.inject({ method: "GET", url: "/api/instance", headers });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as { auth_mode: string; integrations: Status[] };
    return { body, text: response.body, byId: Object.fromEntries(body.integrations.map((item) => [item.id, item])) };
  };
  try {
    const before = await describe(OWNER);
    assert.equal(before.body.auth_mode, "compat-cookie");
    assert.equal(before.byId["web-search"]?.state, "off");
    assert.equal(before.byId["web-search"]?.source, "store");
    assert.equal(before.byId.registry?.source, "env");
    assert.equal(before.byId.billing, undefined, "core lists no hosted integration");

    const stored = await core.inject({
      method: "PUT",
      url: "/api/admin/instance/keys/web-search",
      headers: { ...OWNER, "content-type": "application/json" },
      payload: { values: { api_key: KEY } },
    });
    assert.equal(stored.statusCode, 200, stored.body);
    assert.equal(stored.body.includes(KEY), false);

    const admin = await describe(OWNER);
    const web = admin.byId["web-search"]!;
    assert.equal(web.state, "on");
    assert.deepEqual(web.fields.map((field) => [field.name, field.set]), [["api_key", true]]);
    assert.match(String(web.updated_at), /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(typeof web.set_by, "string");
    assert.ok(web.set_by, "the instance admin sees who wrote the key");
    assert.equal(admin.text.includes(KEY), false);
    assert.deepEqual(web, stored.json().integration, "the key write answers the integration as the admin's descriptor shows it");

    const plain = await describe(MEMBER);
    assert.equal(plain.byId["web-search"]?.state, "on");
    assert.equal(plain.byId["web-search"]?.updated_at, null, "a member sees the state, not the audit");
    assert.equal(plain.byId["web-search"]?.set_by, null);
    assert.deepEqual(plain.byId["web-search"], { ...web, updated_at: null, set_by: null });
    assert.equal(plain.text.includes(KEY), false);

    const stranger = await core.inject({
      method: "GET",
      url: "/api/instance",
      headers: { "X-Guilds-User": "user_nobody" },
    });
    assert.equal(stranger.statusCode, 404);
  } finally {
    setInstanceKeys({});
    await core.close();
    await database.close();
  }
});
