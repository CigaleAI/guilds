import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/seed/connect.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import {
  createIsolatedDatabase,
  dropIsolatedDatabase,
  uniqueDbName,
} from "../helpers/postgres.js";

const OWNER = {
  "X-Guilds-User": "user_operator",
  "X-Guilds-Org": "org_home",
  "content-type": "application/json",
};
const CONFIG = { model: TEST_MODEL, browser: false };

const dbName = uniqueDbName("agent_platform_wake_triggers");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("agents store wake triggers at create and through settings", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const databaseUrl = await createIsolatedDatabase(dbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-wake-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const app = await buildApp(database, {
    db,
    notes,
    scripts: agentScripts(db),
    schedules: agentSchedules(db),
  });

  try {
    const guild = await app.inject({
      method: "POST",
      url: "/api/guilds",
      headers: OWNER,
      payload: { name: "wake-desk" },
    });
    assert.equal(guild.statusCode, 201, guild.body);
    const guildId = String(guild.json().id);

    const plain = await app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/agents`,
      headers: OWNER,
      payload: { name: "wake-plain", focus: "Track papers", config: CONFIG },
    });
    assert.equal(plain.statusCode, 201, plain.body);
    assert.equal(plain.json().wake_triggers, "");

    const seeded = await app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/agents`,
      headers: OWNER,
      payload: { name: "wake-seeded", wake_triggers: "  a paper link is shared  ", config: CONFIG },
    });
    assert.equal(seeded.statusCode, 201, seeded.body);
    assert.equal(seeded.json().wake_triggers, "a paper link is shared");

    const tooLong = await app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/agents`,
      headers: OWNER,
      payload: { name: "wake-long", wake_triggers: "x".repeat(501), config: CONFIG },
    });
    assert.equal(tooLong.statusCode, 422);

    const agentId = String(plain.json().id);
    const set = await app.inject({
      method: "PUT",
      url: `/api/agents/${agentId}/config`,
      headers: OWNER,
      payload: { config: CONFIG, wake_triggers: "someone asks for a summary" },
    });
    assert.equal(set.statusCode, 200, set.body);
    assert.equal(set.json().wake_triggers, "someone asks for a summary");
    assert.equal(set.json().focus, "Track papers");

    const untouched = await app.inject({
      method: "PUT",
      url: `/api/agents/${agentId}/config`,
      headers: OWNER,
      payload: { config: CONFIG, focus: "Track and file papers" },
    });
    assert.equal(untouched.statusCode, 200, untouched.body);
    assert.equal(untouched.json().wake_triggers, "someone asks for a summary");

    const cleared = await app.inject({
      method: "PUT",
      url: `/api/agents/${agentId}/config`,
      headers: OWNER,
      payload: { config: CONFIG, wake_triggers: "" },
    });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(cleared.json().wake_triggers, "");
  } finally {
    await app.close();
    await database.close();
  }
});
