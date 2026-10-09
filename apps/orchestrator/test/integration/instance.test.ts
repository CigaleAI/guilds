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

const dbName = uniqueDbName("agent_platform_instance");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("the instance descriptor lists integrations and their state, never a key", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const before = process.env.TAVILY_API_KEY;
  process.env.TAVILY_API_KEY = "tvly-instance-test-key";
  const database = await connect(await createIsolatedDatabase(dbName));
  const notes = new NotesStore(tempDir("guilds-instance-"), templatesRoot(), "notes");
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool);
  const deps = { repo, notes, scripts: new Scripts(repo), schedules: new Schedules(repo, notes) };
  const core = await buildApp(database, deps);
  try {
    const response = await core.inject({ method: "GET", url: "/api/instance", headers: OWNER });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.auth_mode, "compat-cookie");
    const states = Object.fromEntries(
      body.integrations.map((item: { id: string; state: string }) => [item.id, item.state]),
    );
    assert.equal(states["web-search"], "on");
    assert.equal(states.billing, undefined, "core lists no hosted integration");
    assert.equal(response.body.includes("tvly-instance-test-key"), false);

    const stranger = await core.inject({
      method: "GET",
      url: "/api/instance",
      headers: { "X-Guilds-User": "user_nobody" },
    });
    assert.equal(stranger.statusCode, 404);
  } finally {
    await core.close();
    await database.close();
    if (before === undefined) {
      delete process.env.TAVILY_API_KEY;
    } else {
      process.env.TAVILY_API_KEY = before;
    }
  }
});
