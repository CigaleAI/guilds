import assert from "node:assert/strict";
import { test } from "node:test";
import { dumpsCompact, isJsonObject, isJsonValue, sortKeys } from "../../src/lib/json.js";

test("isJsonValue accepts every value JSON carries, at any depth", () => {
  for (const value of ["text", 0, -1.5, true, false, null, [], {}, [1, "a", null], { a: [{ b: { c: false } }] }]) {
    assert.equal(isJsonValue(value), true, JSON.stringify(value));
  }
  assert.equal(isJsonValue(JSON.parse('{"a":[1,{"b":null}],"c":"d"}')), true);
});

test("isJsonValue refuses a value JSON cannot carry, at any depth", () => {
  for (const value of [undefined, 1n, Symbol("s"), () => 1, new Date(0), new Map(), [1, undefined], { a: [new Date(0)] }]) {
    assert.equal(isJsonValue(value), false, String(value));
  }
});

test("isJsonObject accepts a plain object, and a field left out as undefined", () => {
  assert.equal(isJsonObject({}), true);
  assert.equal(isJsonObject({ a: 1, b: { c: ["d"] }, e: undefined }), true);
  assert.equal(isJsonObject(Object.assign(Object.create(null), { a: 1 })), true);
});

test("isJsonObject refuses an array, a scalar, a class instance, and a field JSON cannot carry", () => {
  for (const value of [null, [], "text", 1, true, new Date(0), new Map(), { a: 1n }, { a: { b: () => 1 } }]) {
    assert.equal(isJsonObject(value), false, String(value));
  }
});

test("sortKeys orders every object's keys at every depth and leaves arrays in order", () => {
  const sorted = sortKeys({ b: 1, a: [{ d: 1, c: 2 }, 3], c: { z: null, y: "x" } });
  assert.equal(JSON.stringify(sorted), '{"a":[{"c":2,"d":1},3],"b":1,"c":{"y":"x","z":null}}');
  assert.equal(sortKeys("text"), "text");
  assert.equal(sortKeys(null), null);
});

test("dumpsCompact leaves out an undefined field and escapes non-ASCII on request", () => {
  assert.equal(dumpsCompact({ b: "é", a: undefined }), '{"b":"é"}');
  assert.equal(dumpsCompact({ b: "é", a: 1 }, true), '{"a":1,"b":"\\u00e9"}');
});
