import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/seed/connect.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { planAfterFire } from "../../src/schedules/timing.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { windowEndAt } from "../../src/schedules/window.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { getSchedule, markScheduleFired } from "../../src/db/schedules.js";

const OWNER = {
  "X-Guilds-User": "user_operator",
  "X-Guilds-Org": "org_home",
};

const WINDOW = { timezone: "Europe/Paris", start: "08:00", end: "20:00", max_wakes: 20 };

const dbName = uniqueDbName("agent_platform_random_routines");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("random-window routines persist, plan inside the window, and users keep a timezone", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const databaseUrl = await createIsolatedDatabase(dbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-random-routines-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const schedules = agentSchedules(db);
  const app = await buildApp(database, { db, notes, scripts: agentScripts(db), schedules });
  const json = { ...OWNER, "content-type": "application/json" };

  try {
    const me = await app.inject({ method: "PATCH", url: "/api/auth/me", headers: json, payload: { timezone: "europe/paris" } });
    assert.equal(me.statusCode, 200, me.body);
    assert.equal(me.json().timezone, "Europe/Paris");
    const bad = await app.inject({ method: "PATCH", url: "/api/auth/me", headers: json, payload: { timezone: "Nowhere/Land" } });
    assert.equal(bad.statusCode, 422);
    const users = await app.inject({ method: "GET", url: "/api/users", headers: OWNER });
    assert.equal(users.json()[0].timezone, "Europe/Paris");
    const cleared = await app.inject({ method: "PATCH", url: "/api/auth/me", headers: json, payload: { timezone: null } });
    assert.equal(cleared.json().timezone, null);

    const guild = await app.inject({ method: "POST", url: "/api/guilds", headers: json, payload: { name: "random-desk", visibility: "org" } });
    const guildId = String(guild.json().id);
    const agent = await app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/agents`,
      headers: json,
      payload: { name: "wanderer", config: { model: TEST_MODEL, browser: false } },
    });
    const agentId = String(agent.json().id);
    const url = `/api/agents/${agentId}/schedules`;

    const both = await app.inject({
      method: "POST",
      url,
      headers: json,
      payload: { cron: "0 9 * * 1", window: WINDOW, description: "Both", instruction: "Look around." },
    });
    assert.equal(both.statusCode, 422);
    assert.match(both.body, /exactly one of cron or window/);
    const crowded = await app.inject({
      method: "POST",
      url,
      headers: json,
      payload: { window: { ...WINDOW, max_wakes: 500 }, description: "Crowded", instruction: "Look around." },
    });
    assert.equal(crowded.statusCode, 422);

    const created = await app.inject({
      method: "POST",
      url,
      headers: json,
      payload: { window: WINDOW, description: "Wander", instruction: "Look around." },
    });
    assert.equal(created.statusCode, 201, created.body);
    const item = created.json();
    assert.equal(item.cron, null);
    assert.deepEqual(item.window, WINDOW);
    assert.equal(item.label, "Up to 20 random wake-ups between 08:00 and 20:00 every day (Europe/Paris)");
    const nextRun = new Date(item.next_run_at);
    assert.notEqual(windowEndAt(WINDOW, nextRun), null);

    const listed = await app.inject({ method: "GET", url, headers: OWNER });
    assert.deepEqual(listed.json()[0].window, WINDOW);

    const row = await getSchedule(db, agentId, String(item.id));
    assert.ok(row);
    const wake = planAfterFire(row, nextRun);
    await markScheduleFired(db, String(item.id), nextRun, wake);
    const fired = await getSchedule(db, agentId, String(item.id));
    assert.equal(Number(fired?.window_fires), wake.windowFires);
    assert.equal(new Date(String(fired?.next_run_at)).getTime(), wake.at.getTime());

    const paused = await app.inject({ method: "PATCH", url: `${url}/${item.id}`, headers: json, payload: { paused: true } });
    assert.equal(paused.json().paused, true);
    const resumed = await app.inject({ method: "PATCH", url: `${url}/${item.id}`, headers: json, payload: { paused: false } });
    assert.equal(resumed.json().paused, false);
    assert.notEqual(windowEndAt(WINDOW, new Date(resumed.json().next_run_at)), null);
    assert.equal(Number((await getSchedule(db, agentId, String(item.id)))?.window_fires), 0);

    await assert.rejects(
      database.pool.query(`UPDATE schedules SET cron = '0 9 * * 1' WHERE id = $1`, [item.id]),
      /schedules_timing_check/,
    );
  } finally {
    await app.close();
    await database.close();
  }
});
