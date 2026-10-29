import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/seed/connect.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { scheduleDatabase, Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import {
  createIsolatedDatabase,
  dropIsolatedDatabase,
  uniqueDbName,
} from "../helpers/postgres.js";
import { userActor } from "../../src/lib/change-actor.js";
import { getSchedule, listDueSchedules } from "../../src/db/schedules.js";

const TEST_ACTOR = userActor({ id: "user_operator", name: "operator" });

const OWNER = {
  "X-Guilds-User": "user_operator",
  "X-Guilds-Org": "org_home",
};

const dbName = uniqueDbName("agent_platform_guild_routines");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("a guild can hold every routine without changing pause", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const databaseUrl = await createIsolatedDatabase(dbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-guild-routines-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const schedules = new Schedules(scheduleDatabase(db));
  const app = await buildApp(database, {
    db,
    notes,
    scripts: agentScripts(db),
    schedules,
  });

  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/guilds",
      headers: { ...OWNER, "content-type": "application/json" },
      payload: { name: "held-desk", visibility: "org" },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().routines_enabled, true);
    const guildId = String(created.json().id);

    const other = await app.inject({
      method: "POST",
      url: "/api/guilds",
      headers: { ...OWNER, "content-type": "application/json" },
      payload: { name: "open-desk", visibility: "org" },
    });
    assert.equal(other.statusCode, 201);
    const otherId = String(other.json().id);

    const agent = await app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/agents`,
      headers: { ...OWNER, "content-type": "application/json" },
      payload: { name: "hold-keeper", config: { model: TEST_MODEL, browser: false } },
    });
    assert.equal(agent.statusCode, 201, agent.body);
    const agentId = String(agent.json().id);

    const otherAgent = await app.inject({
      method: "POST",
      url: `/api/guilds/${otherId}/agents`,
      headers: { ...OWNER, "content-type": "application/json" },
      payload: { name: "open-keeper", config: { model: TEST_MODEL, browser: false } },
    });
    assert.equal(otherAgent.statusCode, 201, otherAgent.body);
    const otherAgentId = String(otherAgent.json().id);

    const active = await schedules.create(TEST_ACTOR, agentId, { cron: "0 9 * * 1" }, "Weekly", "Do the weekly pass.");
    const paused = await schedules.create(TEST_ACTOR, agentId, { cron: "0 10 * * 1" }, "Paused weekly", "Stay paused.", {
      paused: true,
    });
    const neighbor = await schedules.create(TEST_ACTOR, otherAgentId, { cron: "0 9 * * 1" }, "Neighbor", "Keep firing.");
    await database.pool.query(`UPDATE schedules SET next_run_at = $2 WHERE id = ANY($1::text[])`, [
      [active.id, paused.id, neighbor.id],
      "2020-01-01T00:00:00.000Z",
    ]);

    const dueBefore = (await listDueSchedules(db, new Date())).map((row) => String(row.id));
    assert.ok(dueBefore.includes(String(active.id)));
    assert.ok(dueBefore.includes(String(neighbor.id)));
    assert.equal(dueBefore.includes(String(paused.id)), false);

    const bad = await app.inject({
      method: "PUT",
      url: `/api/guilds/${guildId}`,
      headers: { ...OWNER, "content-type": "application/json" },
      payload: { routines_enabled: "false" },
    });
    assert.equal(bad.statusCode, 422);

    const off = await app.inject({
      method: "PUT",
      url: `/api/guilds/${guildId}`,
      headers: { ...OWNER, "content-type": "application/json" },
      payload: { routines_enabled: false },
    });
    assert.equal(off.statusCode, 200);
    assert.equal(off.json().routines_enabled, false);

    const dueWhileOff = (await listDueSchedules(db, new Date())).map((row) => String(row.id));
    assert.equal(dueWhileOff.includes(String(active.id)), false);
    assert.ok(dueWhileOff.includes(String(neighbor.id)));

    const listed = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/schedules`,
      headers: OWNER,
    });
    assert.equal(listed.statusCode, 200);
    const activeRow = listed.json().find((row: { id: string }) => row.id === active.id);
    assert.equal(activeRow.guild_routines_enabled, false);
    assert.equal(activeRow.paused, false);

    const on = await app.inject({
      method: "PUT",
      url: `/api/guilds/${guildId}`,
      headers: { ...OWNER, "content-type": "application/json" },
      payload: { routines_enabled: true },
    });
    assert.equal(on.statusCode, 200);
    assert.equal(on.json().routines_enabled, true);

    const dueAfter = (await listDueSchedules(db, new Date())).map((row) => String(row.id));
    assert.equal(dueAfter.includes(String(active.id)), false);
    assert.ok(dueAfter.includes(String(neighbor.id)));

    const restored = await getSchedule(db, agentId, String(active.id));
    const stillPaused = await getSchedule(db, agentId, String(paused.id));
    assert.ok(Date.parse(String(restored?.next_run_at)) > Date.now());
    assert.equal(stillPaused?.paused, true);
    assert.ok(Date.parse(String(stillPaused?.next_run_at)) < Date.now());
  } finally {
    await app.close();
    await database.close();
  }
});
