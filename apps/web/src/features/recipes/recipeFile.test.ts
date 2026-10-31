import assert from "node:assert/strict";
import { test } from "node:test";
import { readRecipeFile } from "./recipeFile";

test("readRecipeFile returns the JSON a file holds", async () => {
  const file = new Blob([JSON.stringify({ meta: { name: "Desk" } })]);
  assert.deepEqual(await readRecipeFile(file), {
    kind: "json",
    recipe: { meta: { name: "Desk" } },
  });
});

test("readRecipeFile reports a file that is not JSON", async () => {
  assert.deepEqual(await readRecipeFile(new Blob(["{ not json"])), { kind: "not-json" });
});
