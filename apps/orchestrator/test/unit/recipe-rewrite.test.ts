import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectRecipeNotePaths,
  recipeNotePath,
  rewriteHrefsToRecipeIds,
  rewriteHrefsToRecipeRefs,
  rewriteGuildTextToRecipe,
  rewriteRecipePathsToDisplayPaths,
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
  const rewritten = rewriteRecipePathsToDisplayPaths(
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
  const rewritten = rewriteRecipePathsToDisplayPaths("See ![[guild/missing.md]]", new Map());
  assert.equal(rewritten.text, "See ![[guild/missing.md]]");
  assert.deepEqual(rewritten.unresolved, ["guild/missing.md"]);
});

test("apply rewrites plain-text note paths the agent reads with note_get", () => {
  const resolved = new Map([
    ["agent/scout/playbook.md", "org/org_1/agents/a_1/playbook.md"],
    ["guild/desk-protocol.md", "org/org_1/guilds/guild_1/desk-protocol.md"],
  ]);
  const rewritten = rewriteRecipePathsToDisplayPaths(
    "![[guild/desk-protocol.md]]\nThen note_get agent/scout/playbook.md. Keep `agent/scout/playbook.md` current.",
    resolved,
  );
  assert.equal(
    rewritten.text,
    "![[org/org_1/guilds/guild_1/desk-protocol.md]]\nThen note_get org/org_1/agents/a_1/playbook.md. Keep `org/org_1/agents/a_1/playbook.md` current.",
  );
  assert.deepEqual(rewritten.unresolved, []);
});

test("unknown plain-text note paths stay visible and are reported once", () => {
  const rewritten = rewriteRecipePathsToDisplayPaths("note_get agent/scout/missing.md, ![[guild/gone.md]]", new Map());
  assert.equal(rewritten.text, "note_get agent/scout/missing.md, ![[guild/gone.md]]");
  assert.deepEqual(rewritten.unresolved, ["agent/scout/missing.md", "guild/gone.md"]);
});

test("plain-text note paths ignore embeds, live paths, and paths inside other paths", () => {
  assert.deepEqual(
    collectRecipeNotePaths(
      "![[guild/a.md]] note_get org/b.md, see docs/guild/c.md, github.org/d.md, org/org_1/guilds/guild_1/e.md, guild/f.mdx",
    ),
    ["org/b.md"],
  );
});

test("capture turns live note paths back into recipe paths in embeds and plain text", () => {
  const hrefToRef = new Map([["org/org_1/agents/a_1/playbook.md", "agent/scout/playbook.md"]]);
  assert.equal(
    rewriteHrefsToRecipeRefs(
      "![[org/org_1/agents/a_1/playbook.md]] then note_get org/org_1/agents/a_1/playbook.md.",
      hrefToRef,
    ),
    "![[agent/scout/playbook.md]] then note_get agent/scout/playbook.md.",
  );
});

test("a [[…]] reference round-trips between its recipe path and its live display path", () => {
  const live = "org/org_1/guilds/guild_1/desk-protocol.md";
  const applied = rewriteRecipePathsToDisplayPaths(
    "Read [[guild/desk-protocol.md]] when a desk asks.",
    new Map([["guild/desk-protocol.md", live]]),
  );
  assert.equal(applied.text, `Read [[${live}]] when a desk asks.`);
  assert.equal(
    rewriteHrefsToRecipeRefs(applied.text, new Map([[live, "guild/desk-protocol.md"]])),
    "Read [[guild/desk-protocol.md]] when a desk asks.",
  );
});
