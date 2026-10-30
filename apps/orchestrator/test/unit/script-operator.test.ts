import assert from "node:assert/strict";
import { test } from "node:test";
import { operatorActor } from "../../src/artifacts/actors.js";
import { Scripts } from "../../src/scripts/catalog.js";
import { ScriptError } from "../../src/scripts/validation.js";
import {
  clearScripts,
  createScript,
  deleteScript,
  type ScriptChange,
  type ScriptWriteDeps,
} from "../../src/scripts/operator.js";
import { MemoryScriptDB, agentConfig } from "../helpers/generation.js";

const ACTOR = operatorActor({
  orgId: "org_1",
  actorId: "user_1",
  actorName: "test operator",
  guildId: "guild_1",
  agentId: "a_1",
});
const AGENT = { id: "a_1", guild_id: "guild_1", config: agentConfig({ max_scripts: 1 }) };
const DRAFT = { name: "tally", description: "Counts.", source: "print(1)\n", parameters: null };

/** Script writes over an empty catalog, and the changes they announce. */
function announcing(): { deps: ScriptWriteDeps; published: Array<[string, ScriptChange]> } {
  const published: Array<[string, ScriptChange]> = [];
  const deps: ScriptWriteDeps = {
    scripts: new Scripts(new MemoryScriptDB()),
    publishScriptsChanged: async (guildId, change) => {
      published.push([guildId, change]);
    },
  };
  return { deps, published };
}

test("create_script_announces_the_script_to_the_agents_guild", async () => {
  const { deps, published } = announcing();
  assert.equal((await createScript(deps, ACTOR, AGENT, DRAFT)).name, "tally");
  assert.deepEqual(published, [["guild_1", { agentId: "a_1", action: "create", name: "tally" }]]);
});

test("create_script_holds_the_agents_cap_and_announces_nothing_past_it", async () => {
  const { deps, published } = announcing();
  await createScript(deps, ACTOR, AGENT, DRAFT);
  await assert.rejects(createScript(deps, ACTOR, AGENT, { ...DRAFT, name: "sum" }), /limited to 1 scripts/);
  assert.equal(published.length, 1);
});

test("delete_script_announces_the_script_it_named", async () => {
  const { deps, published } = announcing();
  await createScript(deps, ACTOR, AGENT, DRAFT);
  await deleteScript(deps, ACTOR, AGENT, "tally");
  await assert.rejects(deleteScript(deps, ACTOR, AGENT, "tally"), ScriptError);
  assert.deepEqual(published.at(-1), ["guild_1", { agentId: "a_1", action: "delete", name: "tally" }]);
  assert.equal(published.length, 2);
});

test("clear_scripts_announces_every_script_gone", async () => {
  const { deps, published } = announcing();
  await createScript(deps, ACTOR, AGENT, DRAFT);
  await clearScripts(deps, ACTOR, AGENT);
  assert.deepEqual(await deps.scripts.listForAgent("a_1"), []);
  assert.deepEqual(published.at(-1), ["guild_1", { agentId: "a_1", action: "clear", name: null }]);
});

test("script_writes_announce_nothing_without_a_publisher", async () => {
  const quiet: ScriptWriteDeps = { scripts: new Scripts(new MemoryScriptDB()) };
  await createScript(quiet, ACTOR, AGENT, DRAFT);
  await deleteScript(quiet, ACTOR, AGENT, "tally");
  await clearScripts(quiet, ACTOR, AGENT);
});
