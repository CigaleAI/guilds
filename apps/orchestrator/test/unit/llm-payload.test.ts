import assert from "node:assert/strict";
import { test } from "node:test";
import { isPlainObject } from "../../src/llm/payload.js";

test("isPlainObject accepts a JSON object and refuses null, arrays, and scalars", () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject({ id: "gpt-5" }), true);
  for (const value of [null, undefined, [], [{ id: "gpt-5" }], "gpt-5", 5, true]) {
    assert.equal(isPlainObject(value), false, JSON.stringify(value));
  }
});
