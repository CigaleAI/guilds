import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/db/client.js";
import { NotesStore } from "../../src/notes/store.js";
import { scriptDatabase, Scripts } from "../../src/scripts/catalog.js";
import { scheduleDatabase, Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const OWNER = {
  "X-Guilds-User": "user_operator",
  "X-Guilds-Org": "org_home",
};

const dbName = uniqueDbName("agent_platform_org_members");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test(
  "a new user joins the organisation by name and becomes a second guild admin",
  { timeout: 60_000 },
  async () => {
    process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
    const databaseUrl = await createIsolatedDatabase(dbName);
    const database = await connect(databaseUrl);
    const notes = new NotesStore(tempDir("guilds-org-members-"), templatesRoot());
    await notes.ensureSystemPrompt();
    const db = database.pool;
    const app = await buildApp(database, {
      db,
      notes,
      scripts: new Scripts(scriptDatabase(db)),
      schedules: new Schedules(scheduleDatabase(db)),
    });
    const json = { ...OWNER, "content-type": "application/json" };

    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/users",
        headers: { "content-type": "application/json" },
        payload: { name: "second-admin" },
      });
      assert.equal(created.statusCode, 201, created.body);
      const userId = String(created.json().id);

      const unknown = await app.inject({
        method: "POST",
        url: "/api/orgs/org_home/members",
        headers: json,
        payload: { name: "nobody-here" },
      });
      assert.equal(unknown.statusCode, 404);
      const neither = await app.inject({
        method: "POST",
        url: "/api/orgs/org_home/members",
        headers: json,
        payload: { role: "member" },
      });
      assert.equal(neither.statusCode, 422);

      const added = await app.inject({
        method: "POST",
        url: "/api/orgs/org_home/members",
        headers: json,
        payload: { name: " @Second-Admin ", role: "member" },
      });
      assert.equal(added.statusCode, 201, added.body);
      assert.equal(added.json().user_id, userId);
      assert.equal(added.json().role, "member");
      const again = await app.inject({
        method: "POST",
        url: "/api/orgs/org_home/members",
        headers: json,
        payload: { name: "second-admin" },
      });
      assert.equal(again.statusCode, 409);

      const NEWCOMER = {
        "X-Guilds-User": userId,
        "X-Guilds-Org": "org_home",
        "content-type": "application/json",
      };
      const memberAdds = await app.inject({
        method: "POST",
        url: "/api/orgs/org_home/members",
        headers: NEWCOMER,
        payload: { name: "operator" },
      });
      assert.equal(memberAdds.statusCode, 404, "a plain member cannot add people");

      const guild = await app.inject({
        method: "POST",
        url: "/api/guilds",
        headers: json,
        payload: { name: "two-admins", visibility: "private" },
      });
      assert.equal(guild.statusCode, 201, guild.body);
      const promoted = await app.inject({
        method: "PUT",
        url: `/api/guilds/${String(guild.json().id)}/operators/${userId}`,
        headers: json,
        payload: { role: "admin" },
      });
      assert.equal(promoted.statusCode, 200, promoted.body);
      assert.deepEqual(
        promoted
          .json()
          .operators.map((row: { name: string; role: string }) => [row.name, row.role]),
        [
          ["operator", "admin"],
          ["second-admin", "admin"],
        ],
      );
    } finally {
      await app.close();
      await database.close();
    }
  },
);
