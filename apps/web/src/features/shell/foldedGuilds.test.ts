import assert from "node:assert/strict";
import { test } from "node:test";
import { isFoldedGuilds, parseFoldedGuilds } from "./foldedGuilds";

test("a map of guild ids to booleans is the folded guilds", () => {
  assert.equal(isFoldedGuilds({ g_1: true, g_2: false }), true);
  assert.equal(isFoldedGuilds({}), true);
});

test("anything else is not the folded guilds", () => {
  assert.equal(isFoldedGuilds({ g_1: "yes" }), false);
  assert.equal(isFoldedGuilds(["g_1"]), false);
  assert.equal(isFoldedGuilds(null), false);
  assert.equal(isFoldedGuilds("g_1"), false);
});

test("stored folded guilds are read back", () => {
  assert.deepEqual(parseFoldedGuilds('{"g_1":true}'), { g_1: true });
  assert.deepEqual(parseFoldedGuilds("{}"), {});
});

test("stored text that is not JSON or not a map reads as nothing", () => {
  assert.equal(parseFoldedGuilds("{g_1"), null);
  assert.equal(parseFoldedGuilds('["g_1"]'), null);
  assert.equal(parseFoldedGuilds("null"), null);
});
