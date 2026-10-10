import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { decodeMasterKey } from "../../src/config/index.js";
import { connect } from "../../src/db/client.js";
import { Repositories } from "../../src/db/repositories.js";
import { GenerationLoop } from "../../src/generation/index.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { McpPool } from "../../src/mcp/index.js";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { NotesStore } from "../../src/notes/store.js";
import { Scripts } from "../../src/scripts/catalog.js";
import { Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, testEnv } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { ExportSandboxes } from "../helpers/live.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const AUTH = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };

const dbName = uniqueDbName("agent_platform_box");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("an agent is created on a lite or a standard box, and a box change replaces its sandbox", { timeout: 60_000 }, async () => {
  const databaseUrl = await createIsolatedDatabase(dbName);
  const env = testEnv(databaseUrl);
  Object.assign(process.env, env);
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(databaseUrl);
  const notes = new NotesStore(env.NOTES_ROOT ?? "", templatesRoot(), "notes");
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool);
  await connectModelProvider(repo, "org_home", "deepinfra");
  const artifacts = new ArtifactStore(database.pool, notes.templates);
  const sandboxes = new ExportSandboxes(env.WORKSPACE_ROOT ?? "");
  const generation = new GenerationLoop(repo, notes, env.WORKSPACE_ROOT ?? "", sandboxes, {
    mcp: new McpPool(),
    artifacts,
    idleTimeoutMs: 5 * 60 * 1000,
  });
  const app = await buildApp(database, {
    repo,
    notes,
    artifacts,
    scripts: new Scripts(repo),
    schedules: new Schedules(repo, notes),
    masterKey: decodeMasterKey(HEX_MASTER_KEY),
    mcp: new McpPool(),
    generation,
  });
  try {
    const guild = await app.inject({ method: "POST", url: "/api/guilds", headers: JSON_AUTH, payload: { name: "box-desk" } });
    assert.equal(guild.statusCode, 201, guild.body);
    const guildId = String(guild.json().id);

    // The default is the lite box: no browser, no coding.
    const lite = await app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/agents`,
      headers: JSON_AUTH,
      payload: { name: "scripter", config: { model: TEST_MODEL } },
    });
    assert.equal(lite.statusCode, 201, lite.body);
    assert.equal(lite.json().box, "lite");
    assert.equal(lite.json().config.box, "lite");
    assert.equal(lite.json().config.browser, false);
    assert.equal(lite.json().config.coding, false);
    const liteId = String(lite.json().id);

    // The box alone is enough: standard turns browser and coding on.
    const standard = await app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/agents`,
      headers: JSON_AUTH,
      payload: { name: "coder", config: { model: TEST_MODEL, box: "standard" } },
    });
    assert.equal(standard.statusCode, 201, standard.body);
    assert.equal(standard.json().box, "standard");
    assert.equal(standard.json().config.box, "standard");
    assert.equal(standard.json().config.browser, true);
    assert.equal(standard.json().config.coding, true);
    assert.equal(standard.json().config.max_steps, 200, "a new coding agent takes the coding budgets");

    // A box that disagrees with the flags is refused.
    const disagree = await app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/agents`,
      headers: JSON_AUTH,
      payload: { name: "mixed", config: { model: TEST_MODEL, box: "lite", coding: true } },
    });
    assert.equal(disagree.statusCode, 422, disagree.body);
    assert.match(disagree.json().detail, /a lite box has browser and coding off/);
    const empty = await app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/agents`,
      headers: JSON_AUTH,
      payload: { name: "empty", config: { model: TEST_MODEL, box: "standard", browser: false, coding: false } },
    });
    assert.equal(empty.statusCode, 422, empty.body);
    assert.match(empty.json().detail, /a standard box has browser or coding on/);

    // The member list carries each agent's box.
    const listed = await app.inject({ method: "GET", url: `/api/guilds/${guildId}/agents`, headers: AUTH });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(
      Object.fromEntries(listed.json().map((agent: { name: string; box: string }) => [agent.name, agent.box])),
      { scripter: "lite", coder: "standard" },
    );

    // The lite agent's sandbox runs without browser or coding; moving it to standard replaces it.
    const started = await app.inject({ method: "POST", url: `/api/agents/${liteId}/cli`, headers: AUTH });
    assert.equal(started.statusCode, 200, started.body);
    assert.ok(sandboxes.running.has(liteId));
    assert.equal(sandboxes.browserFlags[liteId], false);
    assert.equal(sandboxes.codingFlags[liteId], false);
    const detail = await app.inject({ method: "GET", url: `/api/agents/${liteId}`, headers: AUTH });
    assert.equal(detail.statusCode, 200, detail.body);
    const moved = await app.inject({
      method: "PUT",
      url: `/api/agents/${liteId}/config`,
      headers: JSON_AUTH,
      payload: { config: { ...detail.json().config, box: "standard", browser: true, coding: true } },
    });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal(moved.json().box, "standard");
    assert.equal(moved.json().config.box, "standard");
    assert.deepEqual(sandboxes.destroyed, [liteId], "the lite sandbox is destroyed for the standard image");
    assert.equal(sandboxes.running.has(liteId), false);

    // And back: a lite payload with a flag still on is refused; with both off it goes through.
    const stillOn = await app.inject({
      method: "PUT",
      url: `/api/agents/${liteId}/config`,
      headers: JSON_AUTH,
      payload: { config: { ...moved.json().config, box: "lite", browser: false } },
    });
    assert.equal(stillOn.statusCode, 422, stillOn.body);
    const back = await app.inject({
      method: "PUT",
      url: `/api/agents/${liteId}/config`,
      headers: JSON_AUTH,
      payload: { config: { ...moved.json().config, box: "lite", browser: false, coding: false } },
    });
    assert.equal(back.statusCode, 200, back.body);
    assert.equal(back.json().box, "lite");
  } finally {
    await app.close();
    await generation.close();
    await database.close();
  }
});
