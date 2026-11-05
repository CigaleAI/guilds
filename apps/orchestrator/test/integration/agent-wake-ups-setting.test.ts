import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { artifactStore } from "../../src/artifacts/store.js";
import { generationLoop } from "../../src/generation/index.js";
import { mcpPool } from "../../src/mcp/pool.js";
import { connect } from "../../src/seed/connect.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { ExportSandboxes } from "../helpers/live.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const OWNER = {
  "X-Guilds-User": "user_operator",
  "X-Guilds-Org": "org_home",
  "content-type": "application/json",
};
const CONFIG = { model: TEST_MODEL, browser: false };

const dbName = uniqueDbName("agent_platform_wake_ups_setting");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test(
  "an agent's max_wake_ups defaults to 10, is set through settings, and is frozen on the runs it starts",
  { timeout: 60_000 },
  async () => {
    process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
    const database = await connect(await createIsolatedDatabase(dbName));
    const notes = new NotesStore(tempDir("guilds-wake-ups-notes-"), templatesRoot());
    await notes.ensureSystemPrompt();
    const db = database.pool;
    await connectModelProvider(db, "org_home", "deepinfra");
    const artifacts = artifactStore(db, notes.templates);
    const workspaceRoot = tempDir("guilds-wake-ups-workspaces-");
    const generation = generationLoop(db, {
      mcp: mcpPool(db),
      notes,
      workspaceRoot,
      sandboxes: new ExportSandboxes(workspaceRoot),
      artifacts,
    });
    generation.generateInBackground = () => undefined;
    const app = await buildApp(database, {
      db,
      notes,
      artifacts,
      scripts: agentScripts(db),
      schedules: agentSchedules(db),
      generation,
    });

    try {
      const guild = await app.inject({
        method: "POST",
        url: "/api/guilds",
        headers: OWNER,
        payload: { name: "wake-ups" },
      });
      assert.equal(guild.statusCode, 201, guild.body);
      const created = await app.inject({
        method: "POST",
        url: `/api/guilds/${String(guild.json().id)}/agents`,
        headers: OWNER,
        payload: { name: "waker", config: CONFIG },
      });
      assert.equal(created.statusCode, 201, created.body);
      assert.equal(created.json().config.max_wake_ups, 10);
      const agentId = String(created.json().id);

      const set = await app.inject({
        method: "PUT",
        url: `/api/agents/${agentId}/config`,
        headers: OWNER,
        payload: { config: { ...CONFIG, max_wake_ups: 3 } },
      });
      assert.equal(set.statusCode, 200, set.body);
      assert.equal(set.json().config.max_wake_ups, 3);

      const refused = await app.inject({
        method: "PUT",
        url: `/api/agents/${agentId}/config`,
        headers: OWNER,
        payload: { config: { ...CONFIG, max_wake_ups: 0 } },
      });
      assert.equal(refused.statusCode, 422, refused.body);
      assert.match(refused.body, /max_wake_ups must be a positive integer/);

      const run = await app.inject({
        method: "POST",
        url: `/api/agents/${agentId}/runs`,
        headers: OWNER,
        payload: {},
      });
      assert.equal(run.statusCode, 201, run.body);
      assert.equal(run.json().config_snapshot.max_wake_ups, 3);

      const reset = await app.inject({
        method: "PUT",
        url: `/api/agents/${agentId}/config`,
        headers: OWNER,
        payload: { config: CONFIG },
      });
      assert.equal(reset.statusCode, 200, reset.body);
      assert.equal(
        reset.json().config.max_wake_ups,
        10,
        "a config that leaves it out takes the default",
      );
      const read = await app.inject({
        method: "GET",
        url: `/api/runs/${String(run.json().id)}`,
        headers: OWNER,
      });
      assert.equal(read.statusCode, 200, read.body);
      assert.equal(
        read.json().config_snapshot.max_wake_ups,
        3,
        "a run keeps the value it started with",
      );
    } finally {
      await app.close();
      await database.close();
    }
  },
);
