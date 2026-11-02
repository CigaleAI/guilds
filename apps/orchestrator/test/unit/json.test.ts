import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  JsonObjectSchema,
  JsonValueSchema,
  dumpsCompact,
  isJsonObject,
  isJsonValue,
  sortKeys,
} from "../../src/lib/json.js";

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

test("isJsonObject accepts an object whose prototypes hold nothing, and refuses one that inherits a member", () => {
  function Empty() {}
  Empty.prototype = Object.create(null);
  const bag = Object.assign(Reflect.construct(Empty, []), { a: "1", b: ["2"] });
  assert.equal(isJsonObject(bag), true);
  assert.equal(isJsonObject(Object.assign(Object.create(Object.create(null)), { a: 1 })), true);
  class Holder {
    a = 1;
    read(): number {
      return this.a;
    }
  }
  assert.equal(isJsonObject(new Holder()), false);
  assert.equal(isJsonObject(Object.create({ inherited: 1 })), false);
});

test("isJsonObject refuses an array, a scalar, a class instance, and a field JSON cannot carry", () => {
  for (const value of [null, [], "text", 1, true, new Date(0), new Map(), { a: 1n }, { a: { b: () => 1 } }]) {
    assert.equal(isJsonObject(value), false, String(value));
  }
});

test("JsonValueSchema checks a JSON value at every depth", () => {
  for (const value of ["text", 0, true, null, [1, "a"], { a: [{ b: { c: false } }] }]) {
    assert.equal(Value.Check(JsonValueSchema, value), true, JSON.stringify(value));
  }
  for (const value of [undefined, 1n, new Date(0), [1, undefined], { a: [new Date(0)] }]) {
    assert.equal(Value.Check(JsonValueSchema, value), false, String(value));
  }
});

test("JsonObjectSchema checks a JSON object at every depth, also as a property", () => {
  assert.equal(Value.Check(JsonObjectSchema, { a: 1, b: { c: ["d"] } }), true);
  for (const value of [null, [], "text", new Map(), { a: 1n }, { a: { b: new Date(0) } }]) {
    assert.equal(Value.Check(JsonObjectSchema, value), false, String(value));
  }
  const holder = Type.Object({ settings: Type.Optional(JsonObjectSchema) });
  assert.equal(Value.Check(holder, { settings: { type: "object" } }), true);
  assert.equal(Value.Check(holder, { settings: { when: new Date(0) } }), false);
  assert.equal(Value.Check(holder, {}), true);
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
