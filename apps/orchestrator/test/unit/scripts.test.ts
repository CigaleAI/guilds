import assert from "node:assert/strict";
import { test } from "node:test";
import { operatorActor } from "../../src/artifacts/index.js";
import { Scripts, catalogItem, scriptItem } from "../../src/scripts/catalog.js";
import {
  SCRIPT_DESCRIPTION_MAX,
  ScriptError,
  environmentCatalog,
  scriptSourceHash,
  validateScriptDescription,
  validateScriptName,
  validateScriptParameters,
  validateScriptSource,
} from "../../src/scripts/validation.js";
import { MemoryScriptDB } from "../helpers/generation.js";


const scriptOperator = operatorActor({
  orgId: "org_1",
  actorId: "user_1",
  actorName: "test operator",
  guildId: "guild_1",
  agentId: "a_1",
});

test("validate_script_name", () => {
  assert.equal(validateScriptName(" send_usdc "), "send_usdc");
  assert.throws(() => validateScriptName("  "), /required/);
  assert.throws(() => validateScriptName("manifest"), /reserved/);
  assert.throws(() => validateScriptName("SendUsdc"), /match/);
});

test("validate_script_description", () => {
  assert.equal(validateScriptDescription("  Sign and send USDC  "), "Sign and send USDC");
  assert.throws(() => validateScriptDescription("   "), /non-whitespace/);
  assert.throws(() => validateScriptDescription("x".repeat(SCRIPT_DESCRIPTION_MAX + 1)), /at most/);
});

test("validate_script_source", () => {
  assert.equal(validateScriptSource("print(1)\n"), "print(1)\n");
  assert.throws(() => validateScriptSource("  \n"), /non-whitespace/);
});

test("script_source_hash is sha256 hex", () => {
  const digest = scriptSourceHash("print(1)\n");
  assert.equal(digest, "cc42155088fca5730758db72b2a5bca33112a941dfaa2d43098ec422ce4ea213");
  assert.equal(digest.length, 64);
});

test("validate_script_parameters accepts object or null", () => {
  assert.equal(validateScriptParameters(null), null);
  const schema = { type: "object", properties: { to: { type: "string" } } };
  assert.deepEqual(validateScriptParameters(schema), schema);
  assert.throws(() => validateScriptParameters(["to"]), /JSON object/);
  assert.throws(() => validateScriptParameters("object"), /JSON object/);
});

test("environment_catalog sorts and skips values", () => {
  assert.deepEqual(
    environmentCatalog([
      { name: "WALLET_PRIVATE_KEY", description: "signs USDC", id: "s1" },
      { name: "API_TOKEN", description: "read-only Cigale" },
      { id: "s2" },
    ]),
    [
      { name: "API_TOKEN", description: "read-only Cigale" },
      { name: "WALLET_PRIVATE_KEY", description: "signs USDC" },
    ],
  );
});

test("create rejects native collisions and non-object schemas", async () => {
  const scripts = new Scripts(new MemoryScriptDB());
  await assert.rejects(
    () => scripts.create(scriptOperator, "a_1", "note_find", "why", "print(1)\n"),
    (error: unknown) =>
      error instanceof ScriptError &&
      error.message === "collides with a native or connection tool name",
  );
  await assert.rejects(
    () =>
      scripts.create(scriptOperator, "a_1", "priced", "why", "print(1)\n", {
        type: "string",
      }),
    (error: unknown) =>
      error instanceof ScriptError && error.message === "parameters must be a JSON Schema object",
  );
  await assert.rejects(
    () => scripts.create(scriptOperator, "a_1", "priced", "why", "print(1)\n", ["to"]),
    (error: unknown) =>
      error instanceof ScriptError && error.message === "parameters must be a JSON object",
  );
});

test("Scripts catalog create list get delete", async () => {
  const db = new MemoryScriptDB();
  const scripts = new Scripts(db);
  const created = await scripts.create(
    scriptOperator,
    "a_1",
    "send_usdc",
    "Sign and send USDC",
    "print('sent')\n",
  );
  assert.equal(created.name, "send_usdc");
  assert.equal(created.source, "print('sent')\n");
  assert.equal(created.source_hash, scriptSourceHash("print('sent')\n"));
  assert.equal(created.parameters, null);
  const listed = await scripts.listForAgent("a_1");
  assert.equal(listed.length, 1);
  assert.deepEqual(catalogItem(listed[0]!), {
    name: "send_usdc",
    description: "Sign and send USDC",
  });
  assert.deepEqual(scriptItem(listed[0]!), {
    name: "send_usdc",
    description: "Sign and send USDC",
    parameters: null,
    source: "print('sent')\n",
  });
  const fetched = await scripts.get("a_1", "send_usdc");
  assert.equal(fetched.source, "print('sent')\n");
  await scripts.create(scriptOperator, "a_1", "send_usdc", "updated", "print('again')\n");
  assert.equal((await scripts.get("a_1", "send_usdc")).source, "print('again')\n");
  await scripts.delete(scriptOperator, "a_1", "send_usdc");
  await assert.rejects(() => scripts.get("a_1", "send_usdc"), ScriptError);
});

test("create refuses a new name past max_scripts and still replaces", async () => {
  const scripts = new Scripts(new MemoryScriptDB());
  await scripts.create(scriptOperator, "a_1", "one", "first", "print(1)\n", null, { maxScripts: 1 });
  await assert.rejects(
    () => scripts.create(scriptOperator, "a_1", "two", "second", "print(2)\n", null, { maxScripts: 1 }),
    (error: unknown) =>
      error instanceof ScriptError && error.message === "this agent is limited to 1 scripts",
  );
  await scripts.create(scriptOperator, "a_1", "one", "replaced", "print(9)\n", null, { maxScripts: 1 });
  assert.equal((await scripts.get("a_1", "one")).source, "print(9)\n");
  assert.equal((await scripts.listForAgent("a_1")).length, 1);
});

test("deleteAll removes every script", async () => {
  const scripts = new Scripts(new MemoryScriptDB());
  await scripts.create(scriptOperator, "a_1", "one", "first", "print(1)\n");
  await scripts.create(scriptOperator, "a_1", "two", "second", "print(2)\n");
  const deleted = await scripts.deleteAll(scriptOperator, "a_1");
  assert.equal(deleted.length, 2);
  assert.deepEqual(await scripts.listForAgent("a_1"), []);
});
