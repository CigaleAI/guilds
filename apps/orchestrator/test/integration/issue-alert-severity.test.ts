import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/seed/connect.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const OWNER = {
  "X-Guilds-User": "user_operator",
  "X-Guilds-Org": "org_home",
};

const dbName = uniqueDbName("agent_platform_issue_alert_severity");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("a person sets the least severe issue they are alerted to, and only they read it", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const databaseUrl = await createIsolatedDatabase(dbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-issue-alert-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  const app = await buildApp(database, {
    db,
    notes,
    scripts: agentScripts(db),
    schedules: agentSchedules(db),
  });
  const json = { ...OWNER, "content-type": "application/json" };
  const patch = (payload: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: "/api/auth/me", headers: json, payload });

  try {
    const fresh = await app.inject({ method: "GET", url: "/api/auth/me", headers: OWNER });
    assert.equal(fresh.json().issue_alert_severity, "low", "a new user is alerted to every issue");

    await patch({ timezone: "Europe/Paris" });
    const set = await patch({ issue_alert_severity: "high" });
    assert.equal(set.statusCode, 200, set.body);
    assert.equal(set.json().issue_alert_severity, "high");
    assert.equal(set.json().timezone, "Europe/Paris", "the alert setting leaves the timezone");

    const zone = await patch({ timezone: "UTC" });
    assert.equal(zone.json().issue_alert_severity, "high", "a timezone change leaves the alert setting");

    const users = await app.inject({ method: "GET", url: "/api/users", headers: OWNER });
    assert.equal("issue_alert_severity" in users.json()[0], false);

    for (const severity of ["urgent", "", null, 3]) {
      const bad = await patch({ issue_alert_severity: severity });
      assert.equal(bad.statusCode, 422, `rejects ${String(severity)}`);
    }
    const kept = await app.inject({ method: "GET", url: "/api/auth/me", headers: OWNER });
    assert.equal(kept.json().issue_alert_severity, "high");
  } finally {
    await app.close();
    await database.close();
  }
});
