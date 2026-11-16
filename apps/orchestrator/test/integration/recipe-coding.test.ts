import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { artifactStore } from "../../src/artifacts/store.js";
import { connect } from "../../src/seed/connect.js";
import { setInstanceKeys } from "../../src/instance/integrations.js";
import { NotesStore } from "../../src/notes/store.js";
import { recipeApply } from "../../src/recipes/apply.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { connectModelProvider } from "../helpers/models.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { codeDefaultMachine } from "../helpers/machines.js";
import { listAgents } from "../../src/db/agents.js";

const AUTH = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const dbName = uniqueDbName("agent_platform_recipe_coding");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("a captured coding guild applies with repository steps, each giving its repository to the agents whose role lists it", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const databaseUrl = await createIsolatedDatabase(dbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-recipe-coding-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "openrouter");
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
    const source = await call("POST", "/api/guilds", { name: "code-source" });
    assert.equal(source.statusCode, 201, source.body);
    const sourceId = String(source.json().id);
    await codeDefaultMachine(app, AUTH);
    for (const name of ["api", "web"]) {
      const added = await call("POST", `/api/guilds/${sourceId}/repositories`, {
        name,
        url: `https://git.example.com/team/${name}.git`,
      });
      assert.equal(added.statusCode, 201, added.body);
    }
    const coderConfig = { model: "openrouter/openai/gpt-5.6-luna", browser: false, coding: true, harness: "claude-code" };
    for (const [name, repositories] of [
      ["coder", ["api"]],
      ["reviewer", ["web", "api"]],
    ] as const) {
      const agent = await call("POST", `/api/guilds/${sourceId}/agents`, { name, config: { ...coderConfig, repositories } });
      assert.equal(agent.statusCode, 201, agent.body);
    }

    const captured = await call("POST", `/api/guilds/${sourceId}/recipes`, {});
    assert.equal(captured.statusCode, 201, captured.body);
    const recipeId = String(captured.json().id);
    const body = captured.json().body as Record<string, unknown>;
    assert.deepEqual(body.repositories, [
      { name: "api", purpose: "" },
      { name: "web", purpose: "" },
    ]);
    assert.equal(JSON.stringify(body).includes("git.example.com"), false);
    const roles = body.roles as Array<{ role: string; config: Record<string, unknown> }>;
    assert.equal(roles[0]?.config.coding, true);
    assert.deepEqual(
      Object.fromEntries(roles.map((role) => [role.role, role.config.repositories])),
      { coder: ["api"], reviewer: ["web", "api"] },
    );
    assert.equal((body.connections as Array<{ server: string }>).some((item) => item.server === "github"), false);

    assert.equal((await call("POST", `/api/recipes/${recipeId}/validate`)).statusCode, 200);
    const published = await call("POST", `/api/recipes/${recipeId}/publish`);
    assert.equal(published.statusCode, 200, published.body);
    const preview = await call("POST", `/api/recipes/${recipeId}/preview`, {});
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.json().creates.agents[0].coding, true);
    assert.deepEqual(preview.json().creates.repositories, [
      { name: "api", purpose: "" },
      { name: "web", purpose: "" },
    ]);
    assert.equal(preview.json().remaining.subscription_agents, null, "nothing caps coding agents here");
    assert.deepEqual(preview.json().setups, [], "repositories need no GitHub App while the box has none: each is added with its own credential");

    const applied = await call("POST", `/api/recipes/${recipeId}/apply`, {
      guild_name: "code-target",
      names: [
        { role: "coder", name: "coder-two" },
        { role: "reviewer", name: "reviewer-two" },
      ],
    });
    assert.equal(applied.statusCode, 201, applied.body);
    const apply = applied.json() as { id: string; guild_id: string; checklist: Array<Record<string, unknown>> };
    assert.deepEqual(
      apply.checklist.filter((step) => step.kind === "connection" || step.kind === "repository").map((step) => step.id),
      ["repo:api", "repo:web"],
    );
    const picks = async () =>
      Object.fromEntries((await listAgents(db, apply.guild_id)).map((agent) => [agent.name, agent.config.repositories]));
    const target = await listAgents(db, apply.guild_id);
    assert.equal(target[0]?.config.coding, true);
    assert.deepEqual(await picks(), { "coder-two": [], "reviewer-two": [] }, "the new guild has none of the repositories yet");

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
    assert.deepEqual(await picks(), { "coder-two": ["api"], "reviewer-two": ["api"] });
    const web = await call("POST", `/api/guilds/${apply.guild_id}/repositories`, {
      name: "web",
      url: "https://git.example.com/team/web.git",
    });
    assert.equal(web.statusCode, 201, web.body);
    const webChecked = await call("POST", `/api/applies/${apply.id}/steps/${encodeURIComponent("repo:web")}/verify`);
    assert.equal(webChecked.statusCode, 200, webChecked.body);
    assert.deepEqual(await picks(), { "coder-two": ["api"], "reviewer-two": ["web", "api"] }, "each pick takes its place in the role's order");
  } finally {
    setInstanceKeys({});
    await app.close();
    await database.close();
  }
});
