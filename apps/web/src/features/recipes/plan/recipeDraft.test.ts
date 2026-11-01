import assert from "node:assert/strict";
import { test } from "node:test";
import { isRecipeApproved, needsReview, recipeBody, reviewLabel } from "./recipeDraft";
import { planFromRecipe } from "./planModel";
import { builder, deskRecipe, operator } from "./planFixtures";

test("isRecipeApproved is true only for ready", () => {
  assert.equal(isRecipeApproved("ready"), true);
  assert.equal(isRecipeApproved("draft"), false);
});

test("recipeBody keeps a document and falls back to an empty recipe", () => {
  const doc = deskRecipe();
  assert.equal(recipeBody(doc), doc);
  const empty = { roles: [], collections: [], connections: [], design: {} };
  assert.deepEqual(recipeBody(null), empty);
  assert.deepEqual(recipeBody(undefined), empty);
  assert.equal(planFromRecipe(null).guild.name, "Untitled guild");
});

test("needsReview is builder work that is still unreviewed", () => {
  assert.equal(needsReview(builder), true);
  assert.equal(needsReview({ by: "builder", reviewed: true }), false);
  assert.equal(needsReview(null), false);
  assert.equal(reviewLabel(builder), null);
  assert.equal(reviewLabel(operator), "operator");
});
