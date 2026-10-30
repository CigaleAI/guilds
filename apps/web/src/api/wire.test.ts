import assert from "node:assert/strict";
import { test } from "node:test";
import { hasFields, isNumber, isRecord, isString } from "./wire";

test("isRecord admits an object and refuses null, a list and a scalar", () => {
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord("a"), false);
});

test("the scalar checks admit their own kind only", () => {
  assert.equal(isString("a"), true);
  assert.equal(isString(1), false);
  assert.equal(isNumber(1), true);
  assert.equal(isNumber("1"), false);
});

test("hasFields checks every named field, a missing one included", () => {
  assert.equal(hasFields({ a: "x", b: "y" }, ["a", "b"], isString), true);
  assert.equal(hasFields({ a: "x" }, ["a", "b"], isString), false);
  assert.equal(hasFields({ a: "x", b: 2 }, ["a", "b"], isString), false);
});
