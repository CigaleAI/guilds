import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { connect } from "../../src/db/client.js";
import { Repositories } from "../../src/db/repositories.js";
import { setInstanceKeys } from "../../src/instance/integrations.js";
import { NotesStore } from "../../src/notes/store.js";
import { RecipeApplyService } from "../../src/recipes/apply.js";
import { RecipeStore } from "../../src/recipes/store.js";
import { Scripts } from "../../src/scripts/catalog.js";
import { Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, storeKeys, tempDir } from "../helpers/env.js";
import { connectModelProvider } from "../helpers/models.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { codeDefaultMachine } from "../helpers/machines.js";

const AUTH = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const dbName = uniqueDbName("agent_platform_recipe_coding");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("a captured coding guild applies with GitHub and repository steps", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const databaseUrl = await createIsolatedDatabase(dbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-recipe-coding-notes-"), templatesRoot(), "notes");
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool);
  await connectModelProvider(repo, "org_home", "openrouter");
  await connectModelProvider(repo, "org_home", "deepinfra");
  const artifacts = new ArtifactStore(database.pool, templatesRoot());
  const scripts = new Scripts(repo);
  const schedules = new Schedules(repo, notes);
  const recipes = new RecipeStore(repo.pool);
  const apply = new RecipeApplyService({ repo, recipes, artifacts, notes, scripts, schedules, registry: null });
  const app = await buildApp(database, { repo, notes, artifacts, scripts, schedules, recipes, apply });
  const call = async (method: "GET" | "POST", url: string, payload?: unknown) =>
    app.inject(
      payload === undefined
        ? { method, url, headers: AUTH }
        : { method, url, headers: { ...AUTH, "content-type": "application/json" }, payload: payload as object },
    );
  try {
    const source = await call("POST", "/api/guilds", { name: "code-source" });
    assert.equal(source.statusCode, 201, source.body);
    const sourceId = String(source.json().id);
    await codeDefaultMachine(app, AUTH);
    const agent = await call("POST", `/api/guilds/${sourceId}/agents`, {
      name: "coder",
      config: { model: "openrouter/openai/gpt-5.6-luna", browser: false, coding: true, harness: "claude-code" },
    });
    assert.equal(agent.statusCode, 201, agent.body);
    const added = await call("POST", `/api/guilds/${sourceId}/repositories`, {
      name: "api",
      url: "https://git.example.com/team/api.git",
    });
    assert.equal(added.statusCode, 201, added.body);

    const captured = await call("POST", `/api/guilds/${sourceId}/recipes`, {});
    assert.equal(captured.statusCode, 201, captured.body);
    const recipeId = String(captured.json().id);
    const body = captured.json().body as Record<string, unknown>;
    assert.deepEqual(body.repositories, [{ name: "api", purpose: "" }]);
    assert.equal(JSON.stringify(body).includes("git.example.com"), false);
    const roles = body.roles as Array<{ config: Record<string, unknown> }>;
    assert.equal(roles[0]?.config.coding, true);
    assert.equal((body.connections as Array<{ server: string }>).some((item) => item.server === "github"), false);

    assert.equal((await call("POST", `/api/recipes/${recipeId}/validate`)).statusCode, 200);
    const published = await call("POST", `/api/recipes/${recipeId}/publish`);
    assert.equal(published.statusCode, 200, published.body);
    const preview = await call("POST", `/api/recipes/${recipeId}/preview`, {});
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.json().creates.agents[0].coding, true);
    assert.deepEqual(preview.json().creates.repositories, [{ name: "api", purpose: "" }]);
    assert.equal(preview.json().remaining.coding_agents, null, "nothing caps coding agents here");
    assert.deepEqual(
      preview.json().setups,
      [{ server: "github", integration: "github-app", label: "GitHub App" }],
      "repositories need the GitHub App, which a platform admin has not stored",
    );
    setInstanceKeys(
      storeKeys({ "github-app": { app_id: "4242", slug: "guilds-run-test", private_key: "pem", client_id: "Iv1.client", client_secret: "client-secret" } }),
    );
    const withApp = await call("POST", `/api/recipes/${recipeId}/preview`, {});
    assert.equal(withApp.statusCode, 200, withApp.body);
    assert.deepEqual(withApp.json().setups, []);
    setInstanceKeys({});

    const applied = await call("POST", `/api/recipes/${recipeId}/apply`, {
      guild_name: "code-target",
      names: [{ role: "coder", name: "coder-two" }],
    });
    assert.equal(applied.statusCode, 201, applied.body);
    const apply = applied.json() as { id: string; guild_id: string; checklist: Array<Record<string, unknown>> };
    assert.deepEqual(
      apply.checklist.filter((step) => step.kind === "connection" || step.kind === "repository").map((step) => step.id),
      ["conn:github", "repo:api"],
    );
    const target = await repo.listAgents(apply.guild_id);
    assert.equal((target[0]?.config as Record<string, unknown>).coding, true);

    const early = await call("POST", `/api/applies/${apply.id}/steps/${encodeURIComponent("repo:api")}/verify`);
    assert.equal(early.statusCode, 422, early.body);
    assert.match(String(early.json().detail), /no repository named api/);
    const attached = await call("POST", `/api/guilds/${apply.guild_id}/repositories`, {
      name: "api",
      url: "https://git.example.com/team/api.git",
    });
    assert.equal(attached.statusCode, 201, attached.body);
    const checked = await call("POST", `/api/applies/${apply.id}/steps/${encodeURIComponent("repo:api")}/verify`);
    assert.equal(checked.statusCode, 200, checked.body);
    const step = (checked.json().checklist as Array<Record<string, unknown>>).find((item) => item.id === "repo:api");
    assert.equal(step?.status, "verified");
  } finally {
    setInstanceKeys({});
    await app.close();
    await database.close();
  }
});
