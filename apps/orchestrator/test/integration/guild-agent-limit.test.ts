import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/seed/connect.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { scheduleDatabase, Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const OWNER = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home", "content-type": "application/json" };

const dbName = uniqueDbName("agent_platform_guild_agent_limit");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("creating an agent in a guild at its agent limit answers 409 with the limit", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(await createIsolatedDatabase(dbName));
  const notes = new NotesStore(tempDir("guilds-agent-limit-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const app = await buildApp(database, { db, notes, scripts: agentScripts(db), schedules: new Schedules(scheduleDatabase(db)) });

  try {
    const guild = await app.inject({ method: "POST", url: "/api/guilds", headers: OWNER, payload: { name: "desk" } });
    assert.equal(guild.statusCode, 201, guild.body);
    const guildId = String(guild.json().id);
    const limited = await app.inject({ method: "PUT", url: `/api/guilds/${guildId}`, headers: OWNER, payload: { max_agents: 1 } });
    assert.equal(limited.statusCode, 200, limited.body);
    const config = { model: TEST_MODEL, browser: false };
    const first = await app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/agents`,
      headers: OWNER,
      payload: { name: "scout", config },
    });
    assert.equal(first.statusCode, 201, first.body);

    const past = await app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/agents`,
      headers: OWNER,
      payload: { name: "writer", config },
    });
    assert.equal(past.statusCode, 409, past.body);
    assert.equal(past.json().detail, "this guild is limited to 1 agents");
  } finally {
    await app.close();
    await database.close();
  }
});
