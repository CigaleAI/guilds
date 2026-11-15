import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { artifactStore } from "../../src/artifacts/store.js";
import { installSubscriptionAgents } from "../../src/coding/harnesses.js";
import { listAgents } from "../../src/db/agents.js";
import { NotesStore } from "../../src/notes/store.js";
import { recipeApply } from "../../src/recipes/apply.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { connect } from "../../src/seed/connect.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { codeDefaultMachine } from "../helpers/machines.js";
import { connectModelProvider } from "../helpers/models.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const AUTH = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const dbName = uniqueDbName("agent_platform_recipe_subscription");

after(async () => {
  installSubscriptionAgents("off");
  await dropIsolatedDatabase(dbName);
});

test("a captured subscription role applies on its harness, and is refused while the box turns them off", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const databaseUrl = await createIsolatedDatabase(dbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-recipe-subscription-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const artifacts = artifactStore(database.pool, templatesRoot());
  const scripts = agentScripts(db);
  const schedules = agentSchedules(db);
  const apply = recipeApply({ db, artifacts, notes, scripts, schedules, registry: null });
  const app = await buildApp(database, { db, notes, artifacts, scripts, schedules, apply });
  const call = async (method: "GET" | "POST", url: string, payload?: unknown) =>
    app.inject(
      payload === undefined
        ? { method, url, headers: AUTH }
        : { method, url, headers: { ...AUTH, "content-type": "application/json" }, payload: payload as object },
    );
  try {
    installSubscriptionAgents("on");
    const source = await call("POST", "/api/guilds", { name: "subscription-source" });
    assert.equal(source.statusCode, 201, source.body);
    await codeDefaultMachine(app, AUTH);
    const agent = await call("POST", `/api/guilds/${String(source.json().id)}/agents`, {
      name: "writer",
      config: { model: null, harness: "codex", harness_model: "gpt-6-luna" },
    });
    assert.equal(agent.statusCode, 201, agent.body);

    // The captured role has a harness and no model: a subscription role.
    const captured = await call("POST", `/api/guilds/${String(source.json().id)}/recipes`, {});
    assert.equal(captured.statusCode, 201, captured.body);
    const recipeId = String(captured.json().id);
    const role = (captured.json().body.roles as Array<{ role: string; config: Record<string, unknown> }>)[0];
    assert.equal("model" in (role?.config ?? {}), false);
    assert.equal(role?.config.harness, "codex");
    assert.equal(role?.config.coding, false);
    assert.equal((await call("POST", `/api/recipes/${recipeId}/validate`)).statusCode, 200);
    assert.equal((await call("POST", `/api/recipes/${recipeId}/publish`)).statusCode, 200);

    // The preview asks no model of it, and its harness from those a subscription runs on.
    const preview = await call("POST", `/api/recipes/${recipeId}/preview`, {});
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(preview.json().models, []);
    assert.deepEqual(preview.json().harnesses, [{ role: "writer", recommended: "codex", harness: "codex", subscription: true }]);
    assert.deepEqual(preview.json().errors, []);
    const cursor = await call("POST", `/api/recipes/${recipeId}/preview`, { harnesses: [{ role: "writer", harness: "cursor" }] });
    assert.equal(cursor.statusCode, 422, cursor.body);
    assert.match(String(cursor.json().detail), /harnesses\.writer: Cursor cannot run a subscription agent/);
    const modelled = await call("POST", `/api/recipes/${recipeId}/preview`, {
      models: [{ role: "writer", model: "deepinfra/zai-org/GLM-5.3-Flash" }],
    });
    assert.equal(modelled.statusCode, 422, modelled.body);
    assert.match(String(modelled.json().detail), /models\.writer: a subscription role takes no model/);

    // While the box turns subscription agents off, the role blocks the apply.
    installSubscriptionAgents("off");
    const off = await call("POST", `/api/recipes/${recipeId}/preview`, {});
    assert.equal(off.statusCode, 200, off.body);
    assert.deepEqual(off.json().errors.map((item: { code: string }) => item.code), ["subscription.off"]);
    const refused = await call("POST", `/api/recipes/${recipeId}/apply`, { guild_name: "subscription-off", names: [{ role: "writer", name: "writer-off" }] });
    assert.equal(refused.statusCode, 422, refused.body);
    assert.match(String(refused.json().detail), /subscription agents are turned off on this box/);

    installSubscriptionAgents("on");
    const applied = await call("POST", `/api/recipes/${recipeId}/apply`, {
      guild_name: "subscription-target",
      names: [{ role: "writer", name: "writer-two" }],
      harnesses: [{ role: "writer", harness: "claude-code" }],
    });
    assert.equal(applied.statusCode, 201, applied.body);
    const [created] = await listAgents(db, String(applied.json().guild_id));
    assert.equal(created?.config.model, null);
    assert.equal(created?.config.coding, false);
    assert.equal(created?.config.harness, "claude-code");
    assert.equal(created?.config.harness_model, null, "another harness takes its default model");
  } finally {
    installSubscriptionAgents("off");
    await app.close();
    await database.close();
  }
});
