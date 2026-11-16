import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { artifactStore } from "../../src/artifacts/store.js";
import { BuilderService } from "../../src/builder/index.js";
import { CapabilityService } from "../../src/capabilities/index.js";
import { generationLive } from "../../src/conversation/runner.js";
import { listAgents } from "../../src/db/agents.js";
import type { RecipeDocument, RecipeRole } from "../../src/db/schema/index.js";
import { NotesStore } from "../../src/notes/store.js";
import { recipeApply } from "../../src/recipes/apply.js";
import { builderAuthor } from "../../src/recipes/schema.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { connect } from "../../src/seed/connect.js";
import { tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { completionCalling, completionReply, toolCall } from "../helpers/generation.js";
import { codeDefaultMachine } from "../helpers/machines.js";
import { connectModelProvider, TEST_MODEL } from "../helpers/models.js";
import { limitedPolicy } from "../helpers/policy.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

// The Guild Builder's coach writes a subscription role through its write tool, and the guild it
// deploys holds a subscription agent on that harness.

const AUTH = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };
const dbName = uniqueDbName("agent_platform_builder_subscription");
const originalStream = generationLive.streamCompletion;

after(async () => {
  generationLive.streamCompletion = originalStream;
  await dropIsolatedDatabase(dbName);
});

/** A role on Claude Code with no model, as the coach writes one when the operator asks for a subscription agent. */
function subscriptionRole(): RecipeRole {
  return {
    role: "writer",
    name_suggestion: "writer",
    focus: "drafts the weekly digest",
    wake_triggers: "",
    avatar_shape: "teardrop",
    avatar_color: "#7c5cff",
    scripts: [],
    schedules: [],
    native_tools: { note_find: true, group_post: true },
    config: { harness: "claude-code" },
    task: { body: "Draft the weekly digest from the guild's notes and post it.", embeds: [], author: builderAuthor() },
    browser: { required: false, instructions: "", author: builderAuthor() },
  };
}

test("the Builder's coach writes a subscription role, and its guild deploys with a subscription agent", { timeout: 90_000 }, async () => {
  const database = await connect(await createIsolatedDatabase(dbName));
  const db = database.pool;
  const notes = new NotesStore(tempDir("guilds-builder-subscription-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  await connectModelProvider(db, "org_home", "deepinfra");
  const artifacts = artifactStore(db, templatesRoot());
  const scripts = agentScripts(db);
  const schedules = agentSchedules(db);
  const policy = limitedPolicy({ maxAgents: 10 });
  const capabilities = new CapabilityService(db, policy);
  const apply = recipeApply({ db, artifacts, notes, scripts, schedules, policy, registry: null });
  const builder = new BuilderService({ db, capabilities, apply, policy });
  const app = await buildApp(database, { db, notes, artifacts, scripts, schedules, capabilities, apply, builder });
  try {
    await codeDefaultMachine(app, AUTH);
    const created = await app.inject({ method: "POST", url: "/api/builder/sessions", headers: JSON_AUTH, payload: { model: TEST_MODEL } });
    assert.equal(created.statusCode, 200, created.body);
    const session = created.json();
    const recipe: RecipeDocument = { ...session.recipe.body, roles: [subscriptionRole()] };
    let calls = 0;
    generationLive.streamCompletion = async function* stream() {
      calls += 1;
      yield [
        "done",
        calls === 1
          ? completionCalling([toolCall("call_write", "builder_write_recipe", { expected_body_version: 1, recipe })])
          : completionReply("The writer runs on your Claude Code subscription."),
      ];
    };
    const message = await app.inject({
      method: "POST",
      url: `/api/builder/sessions/${String(session.id)}/messages`,
      headers: JSON_AUTH,
      payload: { content: "One writer on my Claude Code subscription." },
    });
    assert.equal(message.statusCode, 200, message.body);
    await builder.runner.wait(String(session.id));

    // The write keeps the role without a model: the coach's model is no recommendation for it.
    const written = await app.inject({ method: "GET", url: `/api/recipes/${String(session.recipe_id)}`, headers: AUTH });
    assert.equal(written.statusCode, 200, written.body);
    const role = written.json().body.roles[0];
    assert.equal("model" in role.config, false, JSON.stringify(role.config));
    assert.equal(role.config.harness, "claude-code");
    const preview = await app.inject({ method: "POST", url: `/api/recipes/${String(session.recipe_id)}/preview`, headers: JSON_AUTH, payload: {} });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(preview.json().models, []);
    assert.deepEqual(preview.json().harnesses, [{ role: "writer", recommended: "claude-code", harness: "claude-code" }]);
    assert.deepEqual(preview.json().errors, []);

    const published = await app.inject({ method: "POST", url: `/api/builder/sessions/${String(session.id)}/publish`, headers: AUTH });
    assert.equal(published.statusCode, 200, published.body);
    const deployed = await app.inject({ method: "POST", url: `/api/builder/sessions/${String(session.id)}/deploy`, headers: JSON_AUTH, payload: {} });
    assert.equal(deployed.statusCode, 200, deployed.body);
    const [agent] = await listAgents(db, String(deployed.json().guild_id));
    assert.equal(agent?.config.model, null);
    assert.equal(agent?.config.harness, "claude-code");
    assert.equal("coding" in (agent?.config ?? {}), false);
  } finally {
    await app.close();
    await database.close();
  }
});
