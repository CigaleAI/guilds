import assert from "node:assert/strict";
import { test } from "node:test";
import { builderWriteRecipe, builderWriteRejection, builderWriteToolResult } from "../../src/builder/tools.js";
import { emptyRecipe } from "../../src/recipes/minimal.js";
import { parseRecipe } from "../../src/recipes/parse.js";
import { huskLeadMatcherRecipe, linkedInNotionRecipe } from "../helpers/recipe-docs.js";
import {
  parseToolArgs,
  toolArgsAreJsonObject,
  truncatedToolArguments,
} from "../../src/conversation/runner.js";

const truncatedWrite =
  '{"expected_body_version": 1, "recipe": {   "format": "guilds.recipe",   "version": 1,   "meta": {     "name": "Degen Desk"';

test("truncated builder_write_recipe JSON is not a complete object", () => {
  assert.equal(toolArgsAreJsonObject(truncatedWrite), false);
  assert.equal(truncatedToolArguments("length", truncatedWrite), true);
  assert.equal(truncatedToolArguments("tool_calls", truncatedWrite), false);
  assert.equal(truncatedToolArguments("length", '{"expected_body_version":1,"recipe":{}}'), false);
});

test("truncated builder_write_recipe JSON is not treated as a version conflict", async () => {
  const recovered = parseToolArgs(truncatedWrite);
  assert.equal(recovered.recipe, undefined);
  const result = await builderWriteRecipe.handler({} as never, recovered);
  assert.match(String(result.error), /truncated|incomplete/i);
  assert.notEqual(result.code, "conflict");
});

test("builder_write_recipe receipt does not echo the recipe body", () => {
  const recipe = parseRecipe(linkedInNotionRecipe());
  const result = builderWriteToolResult({ body_version: 4 }, recipe);
  assert.equal(result.ok, true);
  assert.equal(result.body_version, 4);
  assert.equal(result.recipe, undefined);
  assert.ok(Array.isArray(result.roles));
  assert.ok(result.roles.length > 0);
});

test("builderWriteRejection blocks empty-task probes and roster shrink", () => {
  const empty = parseRecipe(emptyRecipe({ source: { kind: "builder", session_id: "s" } }));
  const husk = parseRecipe(huskLeadMatcherRecipe());
  assert.match(String(builderWriteRejection(empty, husk)), /empty task\.body/);
  const full = parseRecipe(linkedInNotionRecipe());
  const shrunk = parseRecipe({ ...full, roles: [full.roles[0]] });
  assert.match(String(builderWriteRejection(full, shrunk)), /drop roles/);
  assert.equal(builderWriteRejection(full, full), null);
});
