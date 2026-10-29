import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/seed/connect.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { REGISTRY } from "../../src/toolbox/index.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import {
  createIsolatedDatabase,
  dropIsolatedDatabase,
  uniqueDbName,
} from "../helpers/postgres.js";
import { userActor } from "../../src/lib/change-actor.js";
import { getSchedule } from "../../src/db/schedules.js";
import { createRun } from "../../src/db/runs.js";
import { runSnapshot } from "../helpers/generation.js";
import { toolInvocation, toolFixture } from "../helpers/toolbox.js";

const TEST_ACTOR = userActor({ id: "user_operator", name: "operator" });

const OWNER = {
  "X-Guilds-User": "user_operator",
  "X-Guilds-Org": "org_home",
  "content-type": "application/json",
};

const PAST = "2020-01-01T00:00:00.000Z";

const dbName = uniqueDbName("agent_platform_routine_update");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("an operator and an agent can change a routine in place", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const databaseUrl = await createIsolatedDatabase(dbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-routine-update-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const schedules = agentSchedules(db);
  const app = await buildApp(database, { db, notes, scripts: agentScripts(db), schedules });

  try {
    const guild = await app.inject({
      method: "POST",
      url: "/api/guilds",
      headers: OWNER,
      payload: { name: "edit-desk", visibility: "org" },
    });
    assert.equal(guild.statusCode, 201);
    const agent = await app.inject({
      method: "POST",
      url: `/api/guilds/${guild.json().id}/agents`,
      headers: OWNER,
      payload: { name: "editor", config: { model: TEST_MODEL, browser: false } },
    });
    assert.equal(agent.statusCode, 201, agent.body);
    const agentId = String(agent.json().id);

    const routine = await schedules.create(TEST_ACTOR, agentId, { cron: "0 9 * * 1" }, "Weekly", "Do the pass.");
    const scheduleId = String(routine.id);
    const url = `/api/agents/${agentId}/schedules/${scheduleId}`;
    const plannedAt = async () => {
      await database.pool.query(`UPDATE schedules SET next_run_at = $2 WHERE id = $1`, [scheduleId, PAST]);
    };
    const nextRun = async () => Date.parse(String((await getSchedule(db, agentId, scheduleId))?.next_run_at));

    await plannedAt();
    const text = await app.inject({
      method: "PATCH",
      url,
      headers: OWNER,
      payload: { description: "Weekly digest", instruction: "Write the digest." },
    });
    assert.equal(text.statusCode, 200, text.body);
    assert.equal(text.json().description, "Weekly digest");
    assert.equal(text.json().instruction, "Write the digest.");
    assert.equal(text.json().cron, "0 9 * * 1");
    assert.equal(await nextRun(), Date.parse(PAST));

    const retimed = await app.inject({
      method: "PATCH",
      url,
      headers: OWNER,
      payload: { window: { timezone: "Europe/Paris", start: "08:00", end: "18:00", max_wakes: 3 } },
    });
    assert.equal(retimed.statusCode, 200, retimed.body);
    assert.equal(retimed.json().cron, null);
    assert.equal(retimed.json().window.timezone, "Europe/Paris");
    assert.equal(retimed.json().description, "Weekly digest");
    assert.ok((await nextRun()) > Date.now());

    const paused = await app.inject({ method: "PATCH", url, headers: OWNER, payload: { paused: true } });
    assert.equal(paused.statusCode, 200);
    assert.equal(paused.json().paused, true);
    assert.equal(paused.json().window.max_wakes, 3);

    const invalid = await app.inject({ method: "PATCH", url, headers: OWNER, payload: { cron: "every day" } });
    assert.equal(invalid.statusCode, 422);
    const missing = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agentId}/schedules/sch_missing`,
      headers: OWNER,
      payload: { description: "Nothing" },
    });
    assert.equal(missing.statusCode, 404);

    await createRun(db,
      {
        runId: "r_edit",
        agentId,
        configSnapshot: runSnapshot(),
        systemContent: "system prompt",
        taskContent: "task prompt",
        userContent: null,
        systemPromptHash: "s",
        taskPromptHash: "t",
        memoryPromptHash: "m",
      },
      new Date(),
    );
    const ctx = toolFixture({
      run_id: "r_edit",
      agent_id: agentId,
      guild_id: String(guild.json().id),
      sandbox: null,
      secrets: {},
      schedules,
      agent_name: "editor",
    });
    const call = toolInvocation(
      "schedule_update",
      { schedule_id: scheduleId, cron: "30 7 * * *", instruction: "Write the morning digest." },
      "call_edit",
    );
    const output = await REGISTRY.schedule_update!.handler(ctx.services, ctx.run, ctx.hooks, call);
    assert.match(String(output), new RegExp(`^updated ${scheduleId} `));
    const updated = await getSchedule(db, agentId, scheduleId);
    assert.equal(updated?.cron, "30 7 * * *");
    assert.equal(updated?.wake_window, null);
    assert.equal(updated?.instruction, "Write the morning digest.");
    assert.equal(updated?.description, "Weekly digest");
    assert.equal(updated?.paused, true);

    const log = await database.pool.query(
      `SELECT summary, actor_type, tool_name FROM config_changes
       WHERE target_kind = 'routine' AND target_id = $1 ORDER BY created_at, id`,
      [scheduleId],
    );
    assert.deepEqual(
      log.rows.map((row) => row.summary),
      [
        'Created "Weekly"',
        'Changed the description and instruction of "Weekly digest"',
        'Changed the timing of "Weekly digest"',
        'Paused "Weekly digest"',
        'Changed the timing and instruction of "Weekly digest"',
      ],
    );
    assert.equal(log.rows.at(-1)?.actor_type, "run");
    assert.equal(log.rows.at(-1)?.tool_name, "schedule_update");
  } finally {
    await app.close();
    await database.close();
  }
});
