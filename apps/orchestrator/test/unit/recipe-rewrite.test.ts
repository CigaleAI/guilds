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
  assert.equal(recipeNotePath({ key: "maps-schema.md" }), "org/maps-schema.md");
});

test("a guild or an agent path is no recipe note path", () => {
  assert.deepEqual(collectRecipeNotePaths("note_get guild/desk-protocol.md and agent/scout/keywords.md"), []);
});

test("apply rewrites destination paths and leftover recipe ids", () => {
  const resolved = new Map([
    ["org/desk-protocol.md", "org/org_1/desk-protocol.md"],
    ["nte1", "org/org_1/schema.md"],
    ["recipe:nte1", "org/org_1/schema.md"],
  ]);
  const rewritten = rewriteRecipePathsToDisplayPaths(
    "See ![[org/desk-protocol.md]] and ![[recipe:nte1]]",
    resolved,
  );
  assert.equal(
    rewritten.text,
    "See ![[org/org_1/desk-protocol.md]] and ![[org/org_1/schema.md]]",
  );
  assert.deepEqual(rewritten.unresolved, []);
});

test("unresolved recipe embeds stay visible", () => {
  const rewritten = rewriteRecipePathsToDisplayPaths("See ![[org/missing.md]]", new Map());
  assert.equal(rewritten.text, "See ![[org/missing.md]]");
  assert.deepEqual(rewritten.unresolved, ["org/missing.md"]);
});

test("apply rewrites plain-text note paths the agent reads with note_get", () => {
  const resolved = new Map([
    ["org/playbook.md", "org/org_1/playbook.md"],
    ["org/desk-protocol.md", "org/org_1/desk-protocol.md"],
  ]);
  const rewritten = rewriteRecipePathsToDisplayPaths(
    "![[org/desk-protocol.md]]\nThen note_get org/playbook.md. Keep `org/playbook.md` current.",
    resolved,
  );
  assert.equal(
    rewritten.text,
    "![[org/org_1/desk-protocol.md]]\nThen note_get org/org_1/playbook.md. Keep `org/org_1/playbook.md` current.",
  );
  assert.deepEqual(rewritten.unresolved, []);
});

test("unknown plain-text note paths stay visible and are reported once", () => {
  const rewritten = rewriteRecipePathsToDisplayPaths("note_get org/missing.md, ![[org/gone.md]]", new Map());
  assert.equal(rewritten.text, "note_get org/missing.md, ![[org/gone.md]]");
  assert.deepEqual(rewritten.unresolved, ["org/missing.md", "org/gone.md"]);
});

test("plain-text note paths ignore embeds, live paths, and paths inside other paths", () => {
  assert.deepEqual(
    collectRecipeNotePaths(
      "![[org/a.md]] note_get org/b.md, see docs/guild/c.md, github.org/d.md, org/org_1/e.md, guild/f.mdx",
    ),
    ["org/b.md"],
  );
});

test("capture turns live note paths back into recipe paths in embeds and plain text", () => {
  const hrefToRef = new Map([["org/org_1/playbook.md", "org/playbook.md"]]);
  assert.equal(
    rewriteHrefsToRecipeRefs(
      "![[org/org_1/playbook.md]] then note_get org/org_1/playbook.md.",
      hrefToRef,
    ),
    "![[org/playbook.md]] then note_get org/playbook.md.",
  );
});

test("a [[…]] reference round-trips between its recipe path and its live display path", () => {
  const live = "org/org_1/desk-protocol.md";
  const applied = rewriteRecipePathsToDisplayPaths(
    "Read [[org/desk-protocol.md]] when a desk asks.",
    new Map([["org/desk-protocol.md", live]]),
  );
  assert.equal(applied.text, `Read [[${live}]] when a desk asks.`);
  assert.equal(
    rewriteHrefsToRecipeRefs(applied.text, new Map([[live, "org/desk-protocol.md"]])),
    "Read [[org/desk-protocol.md]] when a desk asks.",
  );
});
