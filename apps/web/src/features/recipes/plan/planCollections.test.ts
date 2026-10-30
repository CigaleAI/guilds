import assert from "node:assert/strict";
import { test } from "node:test";
import { collectionView } from "./planCollections";
import { planFromRecipe } from "./planModel";
import { deskRecipe } from "./planFixtures";

test("collections normalise their fields and take the apply decision when given", () => {
  const recipe = deskRecipe();
  recipe.collections = [{ name: "loose", columns: [{ name: "n", values: ["a"] }] }];
  const [loose] = planFromRecipe(recipe).collections;
  assert.deepEqual(loose, {
    name: "loose",
    purpose: "",
    columns: [
      { name: "n", type: "text", description: "", required: false, unique: false, values: ["a"] },
    ],
    scope: "org",
    guild: "read",
    writers: [],
    action: "",
    collection_id: null,
    differences: [],
  });
  const overlaid = planFromRecipe(recipe, {
    creates: {
      collections: [
        {
          name: "queue",
          scope: "guild",
          guild: "write",
          action: "conflict",
          collection_id: "c1",
          differences: ["taken"],
        },
      ],
    },
  });
  assert.equal(overlaid.collections.length, 1);
  assert.equal(overlaid.collections[0]?.action, "conflict");
  assert.equal(overlaid.collections[0]?.collection_id, "c1");
});

test("collectionView labels access, the apply decision, conflicts, and column rules", () => {
  const [queue] = planFromRecipe(deskRecipe()).collections;
  assert.ok(queue);
  const view = collectionView(queue);
  assert.equal(view.chip, null);
  assert.equal(view.access, "guild write · writers: @watcher");
  assert.equal(
    view.meta,
    "Organisation table · every agent in the guild gets write · Agent rows at write: @watcher",
  );
  assert.deepEqual(
    view.columns.map((column) => [column.typeLabel, column.rules]),
    [
      ["text", ["required", "unique"]],
      ["text: new | done", ["required"]],
    ],
  );
  const conflict = collectionView({
    ...queue,
    scope: "guild",
    writers: [],
    action: "conflict",
    differences: ["taken"],
  });
  assert.deepEqual(conflict.chip, { label: "conflict", tone: "warn" });
  assert.equal(conflict.access, "the guild's own");
  assert.deepEqual(conflict.conflict, {
    headline: "The organisation already has a table named post-queue.",
    differences: ["taken"],
  });
  assert.deepEqual(collectionView({ ...queue, action: "create" }).chip, {
    label: "new table",
    tone: "action",
  });
  assert.equal(collectionView({ ...queue, action: "reuse" }).reuses, true);
});
