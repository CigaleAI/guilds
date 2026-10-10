import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { buildApp } from "../../src/app.js";
import { decodeMasterKey } from "../../src/config/index.js";
import { connect } from "../../src/db/client.js";
import { Repositories } from "../../src/db/repositories.js";
import { NotesStore } from "../../src/notes/store.js";
import { RecipeApplyService } from "../../src/recipes/apply.js";
import { RecipeStore } from "../../src/recipes/store.js";
import { Scripts } from "../../src/scripts/catalog.js";
import { Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { connectModelProvider } from "../helpers/models.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { cryptoThreeRoleRecipe } from "../helpers/recipe-docs.js";

const AUTH = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };
const dbName = uniqueDbName("agent_platform_apply_secrets");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("apply reuses a secret by granting it to the new guild and waits for the ones to create", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(await createIsolatedDatabase(dbName));
  const notes = new NotesStore(tempDir("guilds-apply-secrets-notes-"), templatesRoot(), "notes");
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool);
  await connectModelProvider(repo, "org_home", "deepinfra");
  const artifacts = new ArtifactStore(database.pool, templatesRoot());
  const scripts = new Scripts(repo);
  const schedules = new Schedules(repo, notes);
  const recipes = new RecipeStore(repo.pool);
  const app = await buildApp(database, {
    repo,
    notes,
    artifacts,
    scripts,
    schedules,
    recipes,
    apply: new RecipeApplyService({ repo, recipes, artifacts, notes, scripts, schedules, registry: null }),
    masterKey: decodeMasterKey(HEX_MASTER_KEY),
  });
  try {
    const existing = await app.inject({
      method: "POST",
      url: "/api/secrets",
      headers: JSON_AUTH,
      payload: { name: "MARKET_KEY", description: "Market data API", value: "live" },
    });
    assert.equal(existing.statusCode, 201, existing.body);

    const recipe = cryptoThreeRoleRecipe();
    recipe.secrets = [
      { name: "MARKET_KEY", description: "Market data API", recommended_scope: "guild", roles: ["researcher", "ta"] },
      { name: "FUND_KEY", description: "Trading account", recommended_scope: "agent", recommended_role: "fund", roles: ["fund"] },
    ];
    const imported = await app.inject({ method: "POST", url: "/api/recipes/import", headers: JSON_AUTH, payload: { recipe } });
    assert.equal(imported.statusCode, 201, imported.body);
    const recipeId = String(imported.json().id);
    for (const step of ["validate", "publish"]) {
      const response = await app.inject({ method: "POST", url: `/api/recipes/${recipeId}/${step}`, headers: AUTH });
      assert.equal(response.statusCode, 200, response.body);
    }

    const preview = await app.inject({ method: "POST", url: `/api/recipes/${recipeId}/preview`, headers: JSON_AUTH, payload: {} });
    assert.equal(preview.statusCode, 200, preview.body);
    const planned = (preview.json().secrets as Array<Record<string, unknown>>).map((row) => [row.name, row.collision, row.action]);
    assert.deepEqual(planned, [
      ["MARKET_KEY", true, "reuse"],
      ["FUND_KEY", false, "create"],
    ]);

    const applied = await app.inject({
      method: "POST",
      url: `/api/recipes/${recipeId}/apply`,
      headers: JSON_AUTH,
      payload: { guild_name: "crypto-secrets" },
    });
    assert.equal(applied.statusCode, 201, applied.body);
    const apply = applied.json() as { id: string; guild_id: string; checklist: Array<{ id: string; status: string }> };
    const status = Object.fromEntries(apply.checklist.map((step) => [step.id, step.status]));
    assert.equal(status["secret:MARKET_KEY"], "verified");
    assert.equal(status["secret:FUND_KEY"], "open");
    const market = await repo.getSecretByName("org_home", "MARKET_KEY");
    assert.deepEqual(
      (market?.grants as Array<{ guild_id: string }>).map((grant) => grant.guild_id),
      [apply.guild_id],
    );

    const early = await app.inject({
      method: "POST",
      url: `/api/applies/${apply.id}/steps/secret:FUND_KEY/verify`,
      headers: AUTH,
    });
    assert.equal(early.statusCode, 422, early.body);
    assert.match(early.body, /FUND_KEY does not reach crypto-fund/);

    const fund = (await repo.listAgents(apply.guild_id)).find((row) => row.name === "crypto-fund");
    assert.ok(fund);
    const created = await app.inject({
      method: "POST",
      url: "/api/secrets",
      headers: JSON_AUTH,
      payload: { name: "FUND_KEY", description: "Trading account", value: "k", agent_ids: [String(fund.id)] },
    });
    assert.equal(created.statusCode, 201, created.body);
    const verified = await app.inject({
      method: "POST",
      url: `/api/applies/${apply.id}/steps/secret:FUND_KEY/verify`,
      headers: AUTH,
    });
    assert.equal(verified.statusCode, 200, verified.body);
    const step = (verified.json().checklist as Array<{ id: string; status: string }>).find((item) => item.id === "secret:FUND_KEY");
    assert.equal(step?.status, "verified");
  } finally {
    await app.close();
    await database.close();
  }
});
