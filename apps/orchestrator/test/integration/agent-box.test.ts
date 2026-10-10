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

test("an agent is created on one of the four boxes, and a box or size change replaces its sandbox", { timeout: 60_000 }, async () => {
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
  const createAgent = (name: string, config: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/agents`,
      headers: JSON_AUTH,
      payload: { name, config: { model: TEST_MODEL, ...config } },
    });
  let guildId = "";
  try {
    const guild = await app.inject({ method: "POST", url: "/api/guilds", headers: JSON_AUTH, payload: { name: "box-desk" } });
    assert.equal(guild.statusCode, 201, guild.body);
    guildId = String(guild.json().id);

    // The default is the lite box: no browser, no coding.
    const lite = await createAgent("scripter", {});
    assert.equal(lite.statusCode, 201, lite.body);
    assert.equal(lite.json().box, "lite");
    assert.equal(lite.json().config.box, "lite");
    assert.equal(lite.json().config.browser, false);
    assert.equal(lite.json().config.coding, false);
    assert.equal("cpu" in lite.json().config, false);
    const liteId = String(lite.json().id);

    // The box alone is enough: standard turns the browser on and keeps coding off, with the default budgets.
    const standard = await createAgent("browser", { box: "standard" });
    assert.equal(standard.statusCode, 201, standard.body);
    assert.equal(standard.json().box, "standard");
    assert.equal(standard.json().config.browser, true);
    assert.equal(standard.json().config.coding, false);
    assert.equal(standard.json().config.max_steps, 30);

    // Code turns both on, with the coding budgets.
    const code = await createAgent("coder", { box: "code" });
    assert.equal(code.statusCode, 201, code.body);
    assert.equal(code.json().box, "code");
    assert.equal(code.json().config.browser, true);
    assert.equal(code.json().config.coding, true);
    assert.equal(code.json().config.max_steps, 200, "a new coding agent takes the coding budgets");

    // Custom takes the operator's size, with the browser on and coding off unless named.
    const custom = await createAgent("sized", { box: "custom", cpu: 2.5, memory_mib: 6144, coding: true });
    assert.equal(custom.statusCode, 201, custom.body);
    assert.equal(custom.json().box, "custom");
    assert.equal(custom.json().config.browser, true);
    assert.equal(custom.json().config.coding, true);
    assert.equal(custom.json().config.cpu, 2.5);
    assert.equal(custom.json().config.memory_mib, 6144);
    const customId = String(custom.json().id);

    // The browser is the operator's on every box but lite.
    const quiet = await createAgent("quiet", { box: "code", browser: false });
    assert.equal(quiet.statusCode, 201, quiet.body);
    assert.equal(quiet.json().config.browser, false);
    assert.equal(quiet.json().config.coding, true);

    // A box that disagrees with the flags, or a size where none belongs, is refused.
    const disagree = await createAgent("mixed", { box: "lite", coding: true });
    assert.equal(disagree.statusCode, 422, disagree.body);
    assert.match(disagree.json().detail, /a lite box has browser and coding off/);
    const standardCoder = await createAgent("standard-coder", { box: "standard", coding: true });
    assert.equal(standardCoder.statusCode, 422, standardCoder.body);
    assert.match(standardCoder.json().detail, /a standard box has coding off/);
    const codeWithout = await createAgent("code-without", { box: "code", coding: false });
    assert.equal(codeWithout.statusCode, 422, codeWithout.body);
    assert.match(codeWithout.json().detail, /a code box has coding on/);
    const unsized = await createAgent("unsized", { box: "custom" });
    assert.equal(unsized.statusCode, 422, unsized.body);
    assert.match(unsized.json().detail, /cpu must be between 0.5 and 4/);
    const oversized = await createAgent("oversized", { box: "custom", cpu: 8, memory_mib: 4096 });
    assert.equal(oversized.statusCode, 422, oversized.body);
    assert.match(oversized.json().detail, /cpu must be between 0.5 and 4/);
    const sizedStandard = await createAgent("sized-standard", { box: "standard", cpu: 2, memory_mib: 4096 });
    assert.equal(sizedStandard.statusCode, 422, sizedStandard.body);
    assert.match(sizedStandard.json().detail, /cpu and memory_mib are only for a custom box/);

    // The member list carries each agent's box.
    const listed = await app.inject({ method: "GET", url: `/api/guilds/${guildId}/agents`, headers: AUTH });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(
      Object.fromEntries(listed.json().map((agent: { name: string; box: string }) => [agent.name, agent.box])),
      { scripter: "lite", browser: "standard", coder: "code", sized: "custom", quiet: "code" },
    );

    // The lite agent's sandbox runs on the lite box; moving it to standard replaces it.
    const started = await app.inject({ method: "POST", url: `/api/agents/${liteId}/cli`, headers: AUTH });
    assert.equal(started.statusCode, 200, started.body);
    assert.ok(sandboxes.running.has(liteId));
    assert.equal(sandboxes.boxes[liteId], "lite");
    assert.equal(sandboxes.browserFlags[liteId], false);
    assert.equal(sandboxes.codingFlags[liteId], false);
    const detail = await app.inject({ method: "GET", url: `/api/agents/${liteId}`, headers: AUTH });
    assert.equal(detail.statusCode, 200, detail.body);
    const moved = await app.inject({
      method: "PUT",
      url: `/api/agents/${liteId}/config`,
      headers: JSON_AUTH,
      payload: { config: { ...detail.json().config, box: "standard", browser: true } },
    });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal(moved.json().box, "standard");
    assert.equal(moved.json().config.box, "standard");
    assert.deepEqual(sandboxes.destroyed, [liteId], "the lite sandbox is destroyed for the standard image");
    assert.equal(sandboxes.running.has(liteId), false);

    // And back: a lite payload with the browser still on is refused; with both off it goes through.
    const stillOn = await app.inject({
      method: "PUT",
      url: `/api/agents/${liteId}/config`,
      headers: JSON_AUTH,
      payload: { config: { ...moved.json().config, box: "lite" } },
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

    // A custom agent's sandbox takes its size; resizing it replaces the sandbox.
    const customStarted = await app.inject({ method: "POST", url: `/api/agents/${customId}/cli`, headers: AUTH });
    assert.equal(customStarted.statusCode, 200, customStarted.body);
    assert.equal(sandboxes.boxes[customId], "custom");
    assert.deepEqual(sandboxes.sizes[customId], { cpu: 2.5, memory_mib: 6144 });
    const destroyedBefore = sandboxes.destroyed.length;
    const resized = await app.inject({
      method: "PUT",
      url: `/api/agents/${customId}/config`,
      headers: JSON_AUTH,
      payload: { config: { ...custom.json().config, memory_mib: 8192 } },
    });
    assert.equal(resized.statusCode, 200, resized.body);
    assert.equal(resized.json().config.memory_mib, 8192);
    assert.deepEqual(sandboxes.destroyed.slice(destroyedBefore), [customId], "a resized custom box gets a new sandbox");
    // Leaving custom drops the size with the box.
    const toCode = await app.inject({
      method: "PUT",
      url: `/api/agents/${customId}/config`,
      headers: JSON_AUTH,
      payload: { config: { ...resized.json().config, box: "code", cpu: undefined, memory_mib: undefined } },
    });
    assert.equal(toCode.statusCode, 200, toCode.body);
    assert.equal(toCode.json().box, "code");
    assert.equal("cpu" in toCode.json().config, false);
  } finally {
    await app.close();
    await generation.close();
    await database.close();
  }
});
