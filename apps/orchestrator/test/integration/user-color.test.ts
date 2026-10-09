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
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const OWNER = {
  "X-Guilds-User": "user_operator",
  "X-Guilds-Org": "org_home",
};

const dbName = uniqueDbName("agent_platform_user_color");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("a person sets, keeps and clears their identity colour", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const databaseUrl = await createIsolatedDatabase(dbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-user-color-"), templatesRoot(), "notes");
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool);
  const app = await buildApp(database, {
    repo,
    notes,
    scripts: new Scripts(repo),
    schedules: new Schedules(repo, notes),
  });
  const json = { ...OWNER, "content-type": "application/json" };
  const patch = (payload: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: "/api/auth/me", headers: json, payload });

  try {
    const fresh = await app.inject({ method: "GET", url: "/api/auth/me", headers: OWNER });
    assert.equal(fresh.json().color, null);

    await patch({ timezone: "Europe/Paris" });
    const set = await patch({ color: "#1FAFD1" });
    assert.equal(set.statusCode, 200, set.body);
    assert.equal(set.json().color, "#1fafd1");
    assert.equal(set.json().timezone, "Europe/Paris", "a colour change leaves the timezone");

    const zone = await patch({ timezone: "UTC" });
    assert.equal(zone.json().color, "#1fafd1", "a timezone change leaves the colour");

    const members = await app.inject({
      method: "GET",
      url: "/api/orgs/org_home/members",
      headers: OWNER,
    });
    assert.equal(members.json()[0].color, "#1fafd1");
    const users = await app.inject({ method: "GET", url: "/api/users", headers: OWNER });
    assert.equal(users.json()[0].color, "#1fafd1");

    for (const color of ["blue", "#1fafd", 42]) {
      const bad = await patch({ color });
      assert.equal(bad.statusCode, 422, `rejects ${String(color)}`);
    }
    const empty = await patch({});
    assert.equal(empty.statusCode, 422);

    const cleared = await patch({ color: null });
    assert.equal(cleared.json().color, null);
  } finally {
    await app.close();
    await database.close();
  }
});
