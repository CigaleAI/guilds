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
import { cryptoThreeRoleRecipe } from "../helpers/recipe-docs.js";
import { insertMember } from "../../src/db/orgs.js";
import { insertUser } from "../../src/db/users.js";
import { recipeApply } from "../../src/recipes/apply.js";

const OWNER = {
  "X-Guilds-User": "user_operator",
  "X-Guilds-Org": "org_home",
  "content-type": "application/json",
};
const OPERATOR = { ...OWNER, "X-Guilds-User": "user_turns_operator" };
const CONFIG = { model: TEST_MODEL, browser: false };

const dbName = uniqueDbName("agent_platform_tool_result_turns");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test(
  "a new guild keeps two tool-result turns, an agent that sets none takes its guild's, and only a guild admin sets either",
  { timeout: 60_000 },
  async () => {
    process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
    const database = await connect(await createIsolatedDatabase(dbName));
    const notes = new NotesStore(tempDir("guilds-tool-result-turns-notes-"), templatesRoot());
    await notes.ensureSystemPrompt();
    const db = database.pool;
    await connectModelProvider(db, "org_home", "deepinfra");
    const artifacts = artifactStore(db, notes.templates);
    const workspaceRoot = tempDir("guilds-tool-result-turns-workspaces-");
    const generation = generationLoop(db, {
      mcp: mcpPool(db),
      notes,
      workspaceRoot,
      sandboxes: new ExportSandboxes(workspaceRoot),
      artifacts,
    });
    generation.generateInBackground = () => undefined;
    const scripts = agentScripts(db);
    const schedules = agentSchedules(db);
    const app = await buildApp(database, {
      db,
      notes,
      artifacts,
      scripts,
      schedules,
      generation,
      apply: recipeApply({ db, artifacts, notes, scripts, schedules, registry: null }),
    });
    const operator = await insertUser(
      db,
      { userId: OPERATOR["X-Guilds-User"], name: "turns-operator", image: null, email: "turns-operator@example.com" },
      new Date(),
    );
    await insertMember(db, { org_id: "org_home", user_id: String(operator.id), role: "member" }, new Date());
    const putGuild = (guildId: string, payload: Record<string, unknown>, headers: Record<string, string> = OWNER) =>
      app.inject({ method: "PUT", url: `/api/guilds/${guildId}`, headers, payload });
    const putConfig = (agentId: string, config: Record<string, unknown>, headers: Record<string, string> = OWNER) =>
      app.inject({ method: "PUT", url: `/api/agents/${agentId}/config`, headers, payload: { config } });
    const startRun = async (agentId: string): Promise<{ id: string; keep: unknown }> => {
      const run = await app.inject({ method: "POST", url: `/api/agents/${agentId}/runs`, headers: OWNER, payload: {} });
      assert.equal(run.statusCode, 201, run.body);
      return { id: String(run.json().id), keep: run.json().config_snapshot.keep_tool_result_generations };
    };

    try {
      const guild = await app.inject({ method: "POST", url: "/api/guilds", headers: OWNER, payload: { name: "turns" } });
      assert.equal(guild.statusCode, 201, guild.body);
      assert.equal(guild.json().keep_tool_result_generations, 2);
      const guildId = String(guild.json().id);

      for (const refused of [0, 1.5]) {
        const response = await putGuild(guildId, { keep_tool_result_generations: refused });
        assert.equal(response.statusCode, 422, response.body);
        assert.match(response.body, /keep_tool_result_generations must be a positive integer/);
      }
      const unstorable = await putGuild(guildId, { keep_tool_result_generations: 3_000_000_000 });
      assert.equal(unstorable.statusCode, 422, unstorable.body);
      assert.match(unstorable.body, /keep_tool_result_generations must be at most 2147483647/);
      const set = await putGuild(guildId, { keep_tool_result_generations: 3 });
      assert.equal(set.statusCode, 200, set.body);
      assert.equal(set.json().keep_tool_result_generations, 3);
      const read = await app.inject({ method: "GET", url: `/api/guilds/${guildId}`, headers: OWNER });
      assert.equal(read.json().keep_tool_result_generations, 3);
      const renamed = await putGuild(guildId, { about: "kept" });
      assert.equal(renamed.json().keep_tool_result_generations, 3, "a patch that leaves it out keeps it");

      const rostered = await app.inject({
        method: "PUT",
        url: `/api/guilds/${guildId}/operators/${String(operator.id)}`,
        headers: OWNER,
        payload: { role: "operator" },
      });
      assert.equal(rostered.statusCode, 200, rostered.body);
      const operatorSets = await putGuild(guildId, { keep_tool_result_generations: 5 }, OPERATOR);
      assert.equal(operatorSets.statusCode, 403, operatorSets.body);
      assert.match(operatorSets.body, /only a guild admin can do this/);
      const operatorKeeps = await putGuild(guildId, { about: "still kept", keep_tool_result_generations: 3 }, OPERATOR);
      assert.equal(operatorKeeps.statusCode, 200, "an operator's save that leaves the guild's value as it is passes");

      const created = await app.inject({
        method: "POST",
        url: `/api/guilds/${guildId}/agents`,
        headers: OWNER,
        payload: { name: "reader", config: CONFIG },
      });
      assert.equal(created.statusCode, 201, created.body);
      assert.equal(created.json().config.keep_tool_result_generations, null);
      const agentId = String(created.json().id);
      assert.equal((await startRun(agentId)).keep, 3, "an agent that sets none takes its guild's");

      const operatorCreates = await app.inject({
        method: "POST",
        url: `/api/guilds/${guildId}/agents`,
        headers: OPERATOR,
        payload: { name: "own-turns", config: { ...CONFIG, keep_tool_result_generations: 2 } },
      });
      assert.equal(operatorCreates.statusCode, 403, operatorCreates.body);
      assert.match(operatorCreates.body, /only a guild admin can do this/);
      const operatorSetsAgent = await putConfig(agentId, { ...CONFIG, keep_tool_result_generations: 2 }, OPERATOR);
      assert.equal(operatorSetsAgent.statusCode, 403, operatorSetsAgent.body);
      const operatorKeepsAgent = await putConfig(agentId, { ...CONFIG, max_steps: 40 }, OPERATOR);
      assert.equal(operatorKeepsAgent.statusCode, 200, "an operator's edit that leaves the agent's value as it is passes");
      assert.equal(operatorKeepsAgent.json().config.keep_tool_result_generations, null);

      const own = await putConfig(agentId, { ...CONFIG, keep_tool_result_generations: 1 });
      assert.equal(own.statusCode, 200, own.body);
      assert.equal(own.json().config.keep_tool_result_generations, 1);
      const overridden = await startRun(agentId);
      assert.equal(overridden.keep, 1, "the agent's own wins over its guild's");
      await putGuild(guildId, { keep_tool_result_generations: 4 });
      assert.equal((await startRun(agentId)).keep, 1, "a guild change leaves an agent's own alone");

      const refused = await putConfig(agentId, { ...CONFIG, keep_tool_result_generations: 0 });
      assert.equal(refused.statusCode, 422, refused.body);
      assert.match(refused.body, /keep_tool_result_generations must be a positive integer/);

      const asAgent = await putConfig(
        agentId,
        { ...CONFIG, keep_tool_result_generations: 5 },
        { ...OWNER, "X-Guilds-User": agentId },
      );
      assert.equal(asAgent.statusCode, 404, asAgent.body);
      assert.match(asAgent.body, /user not found/);
      const stored = await db.query<{ keep: unknown }>(
        "SELECT config->'keep_tool_result_generations' AS keep FROM agents WHERE id = $1",
        [agentId],
      );
      assert.equal(stored.rows[0]?.keep, 1, "an agent is no user, and changes nothing");

      const inherit = await putConfig(agentId, { ...CONFIG, keep_tool_result_generations: null });
      assert.equal(inherit.statusCode, 200, inherit.body);
      assert.equal(inherit.json().config.keep_tool_result_generations, null);
      assert.equal((await startRun(agentId)).keep, 4, "an agent back on null takes its guild's again");

      const kept = await app.inject({ method: "GET", url: `/api/runs/${overridden.id}`, headers: OWNER });
      assert.equal(kept.json().config_snapshot.keep_tool_result_generations, 1, "a run keeps the value it started with");

      const empty = await app.inject({ method: "POST", url: "/api/guilds", headers: OWNER, payload: { name: "turns-empty" } });
      const emptyId = String(empty.json().id);
      await app.inject({
        method: "PUT",
        url: `/api/guilds/${emptyId}/operators/${String(operator.id)}`,
        headers: OWNER,
        payload: { role: "operator" },
      });
      const recipe = cryptoThreeRoleRecipe();
      recipe.roles[0]!.config.keep_tool_result_generations = 3;
      const imported = await app.inject({ method: "POST", url: "/api/recipes/import", headers: OWNER, payload: { recipe } });
      assert.equal(imported.statusCode, 201, imported.body);
      const recipeId = String(imported.json().id);
      for (const step of ["validate", "publish"]) {
        const response = await app.inject({
          method: "POST",
          url: `/api/recipes/${recipeId}/${step}`,
          headers: { "X-Guilds-User": OWNER["X-Guilds-User"], "X-Guilds-Org": OWNER["X-Guilds-Org"] },
        });
        assert.equal(response.statusCode, 200, response.body);
      }
      const preview = (headers: Record<string, string>) =>
        app.inject({ method: "POST", url: `/api/recipes/${recipeId}/preview`, headers, payload: { guild_id: emptyId } });
      const operatorPreview = await preview(OPERATOR);
      assert.equal(operatorPreview.statusCode, 403, operatorPreview.body);
      assert.match(operatorPreview.body, /only a guild admin can apply a recipe that sets keep_tool_result_generations/);
      const adminPreview = await preview(OWNER);
      assert.equal(adminPreview.statusCode, 200, adminPreview.body);
    } finally {
      await app.close();
      await database.close();
    }
  },
);
