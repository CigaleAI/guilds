import assert from "node:assert/strict";
import { test } from "node:test";
import { modelSourceOf } from "../../src/db/schema/index.js";

test("an agent with a model runs on that model on a key", () => {
  assert.deepEqual(modelSourceOf({ model: "deepinfra/zai-org/GLM-5.3-Flash" }), {
    kind: "key",
    model: "deepinfra/zai-org/GLM-5.3-Flash",
  });
});

test("an agent without a model runs on a subscription", () => {
  assert.deepEqual(modelSourceOf({ model: null }), { kind: "subscription" });
});
