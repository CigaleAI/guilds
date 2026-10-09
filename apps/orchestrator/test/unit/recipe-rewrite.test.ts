import assert from "node:assert/strict";
import { test } from "node:test";
import {
  recipeNotePath,
  rewriteHrefsToRecipeIds,
  rewriteGuildTextToRecipe,
  rewriteRecipeEmbedsToDisplayPaths,
  rewriteRecipeIdsToHrefs,
  rewriteRolesToNames,
  rewriteTagsToRoles,
} from "../../src/recipes/rewrite.js";

test("role tags rewrite and leave @user and unknown names", () => {
  const names = new Map([
    ["alice", "researcher"],
    ["bob", "writer"],
  ]);
  const text = "Ask @alice then @bob and keep @user and @metadata.";
  assert.equal(
    rewriteTagsToRoles(text, names),
    "Ask @{researcher} then @{writer} and keep @user and @metadata.",
  );
  assert.equal(
    rewriteRolesToNames("Ask @{researcher} then @{writer}.", new Map([["researcher", "alice"], ["writer", "bob"]])),
    "Ask @alice then @bob.",
  );
});

test("recipe embed ids round-trip", () => {
  const hrefToId = new Map([["org/x/brief.md", "nte1"]]);
  const rewritten = rewriteHrefsToRecipeIds("See ![[org/x/brief.md]]", hrefToId);
  assert.equal(rewritten, "See ![[recipe:nte1]]");
  assert.equal(rewriteRecipeIdsToHrefs(rewritten, new Map([["nte1", "org/x/brief.md"]])), "See ![[org/x/brief.md]]");
  assert.equal(
    rewriteGuildTextToRecipe("Ping @alice and ![[org/x/brief.md]]", new Map([["alice", "researcher"]]), hrefToId),
    "Ping @{researcher} and ![[recipe:nte1]]",
  );
});

test("recipe note path is the destination file, not an opaque id", () => {
  assert.equal(recipeNotePath({ level: "guild", key: "desk-protocol.md" }), "guild/desk-protocol.md");
  assert.equal(recipeNotePath({ level: "org", key: "maps-schema.md" }), "org/maps-schema.md");
  assert.equal(recipeNotePath({ level: "agent", role: "scout", key: "keywords.md" }), "agent/scout/keywords.md");
});

test("apply rewrites destination paths and leftover recipe ids", () => {
  const resolved = new Map([
    ["guild/desk-protocol.md", "org/org_1/guilds/guild_1/desk-protocol.md"],
    ["nte1", "org/org_1/guilds/guild_1/schema.md"],
    ["recipe:nte1", "org/org_1/guilds/guild_1/schema.md"],
  ]);
  const rewritten = rewriteRecipeEmbedsToDisplayPaths(
    "See ![[guild/desk-protocol.md]] and ![[recipe:nte1]]",
    resolved,
  );
  assert.equal(
    rewritten.text,
    "See ![[org/org_1/guilds/guild_1/desk-protocol.md]] and ![[org/org_1/guilds/guild_1/schema.md]]",
  );
  assert.deepEqual(rewritten.unresolved, []);
});

test("unresolved recipe embeds stay visible", () => {
  const rewritten = rewriteRecipeEmbedsToDisplayPaths("See ![[guild/missing.md]]", new Map());
  assert.equal(rewritten.text, "See ![[guild/missing.md]]");
  assert.deepEqual(rewritten.unresolved, ["guild/missing.md"]);
});
