import assert from "node:assert/strict";
import { test } from "node:test";
import { isRecipeApproved, needsReview, recipeBody, reviewLabel } from "./recipeDraft";
import { planFromRecipe } from "./planModel";
import { builder, deskRecipe, operator } from "./planFixtures";

test("isRecipeApproved is true only for ready", () => {
  assert.equal(isRecipeApproved("ready"), true);
  assert.equal(isRecipeApproved("draft"), false);
  assert.equal(isRecipeApproved(null), false);
});

test("recipeBody unwraps a row, keeps a document, and falls back to an empty recipe", () => {
  const doc = deskRecipe();
  assert.equal(recipeBody({ id: "r1", body: doc }), doc);
  assert.equal(recipeBody(doc), doc);
  assert.deepEqual(recipeBody(null), { roles: [], collections: [], connections: [], design: {} });
  assert.equal(planFromRecipe(null).guild.name, "Untitled guild");
});

test("recipeBody reads only objects as recipe documents", () => {
  const empty = { roles: [], collections: [], connections: [], design: {} };
  assert.deepEqual(recipeBody("a recipe"), empty);
  assert.deepEqual(recipeBody([deskRecipe()]), empty);
  const row = { id: "r1", body: "not a document" };
  assert.equal(recipeBody(row), row);
});

test("needsReview is builder work that is still unreviewed", () => {
  assert.equal(needsReview(builder), true);
  assert.equal(needsReview({ by: "builder", reviewed: true }), false);
  assert.equal(needsReview(null), false);
  assert.equal(reviewLabel(builder), null);
  assert.equal(reviewLabel(operator), "operator");
});
