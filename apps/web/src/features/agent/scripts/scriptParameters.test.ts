import assert from "node:assert/strict";
import { test } from "node:test";
import { readParameters } from "./scriptParameters";

test("empty parameters make a plain script", () => {
  assert.deepEqual(readParameters("  \n"), { schema: null, error: undefined });
});

test("a JSON Schema object is the script's parameters", () => {
  const schema = { type: "object", properties: { city: { type: "string" } } };
  assert.deepEqual(readParameters(JSON.stringify(schema)), { schema, error: undefined });
});

test("text that is not JSON says so", () => {
  assert.deepEqual(readParameters("{ type: object"), { schema: null, error: "Not valid JSON." });
});

test("JSON that is not an object schema asks for one", () => {
  const error = 'A JSON Schema object, with "type": "object".';
  assert.deepEqual(readParameters('{ "type": "string" }'), { schema: null, error });
  assert.deepEqual(readParameters('[{ "type": "object" }]'), { schema: null, error });
  assert.deepEqual(readParameters("null"), { schema: null, error });
});
