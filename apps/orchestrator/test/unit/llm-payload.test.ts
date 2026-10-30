import assert from "node:assert/strict";
import { test } from "node:test";
import { isPlainObject, optionalString } from "../../src/llm/payload.js";

test("isPlainObject accepts a JSON object and refuses null, arrays, and scalars", () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject({ id: "gpt-5" }), true);
  for (const value of [null, undefined, [], [{ id: "gpt-5" }], "gpt-5", 5, true]) {
    assert.equal(isPlainObject(value), false, JSON.stringify(value));
  }
});

test("optionalString keeps a non-empty string and is null for an empty one or another type", () => {
  assert.equal(optionalString("chatcmpl-1"), "chatcmpl-1");
  for (const value of ["", null, undefined, 5, {}, ["id"]]) {
    assert.equal(optionalString(value), null, JSON.stringify(value));
  }
});
