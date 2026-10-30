import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyArgValues, fieldsFromSchema, isPlainObject, parseArgValues } from "./toolArgs";

test("only_a_json_object_counts_as_a_plain_object", () => {
  assert.equal(isPlainObject({ type: "object" }), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject("{}"), false);
});

test("object properties become typed fields; an empty schema is a JSON blob", () => {
  assert.deepEqual(
    fieldsFromSchema({
      type: "object",
      properties: {
        query: { type: "string", description: "Name" },
        limit: { type: "integer" },
        live: { type: "boolean" },
        kind: { type: "string", enum: ["price", "ohlc"] },
        tags: { type: "array" },
      },
      required: ["query"],
    }),
    [
      { name: "query", kind: "string", required: true, description: "Name" },
      { name: "limit", kind: "integer", required: false },
      { name: "live", kind: "boolean", required: false },
      { name: "kind", kind: "enum", required: false, values: ["price", "ohlc"] },
      { name: "tags", kind: "json", required: false },
    ],
  );
  assert.deepEqual(fieldsFromSchema({ type: "object" }), [
    { name: "arguments", kind: "json", required: false, description: "JSON object." },
  ]);
});

test("form text becomes arguments; empty optional fields drop out", () => {
  const fields = fieldsFromSchema({
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "integer" },
      live: { type: "boolean" },
      tags: { type: "array" },
    },
    required: ["query"],
  });
  assert.deepEqual(
    parseArgValues(fields, { query: "eth", limit: "15", live: "true", tags: '["a"]' }),
    { arguments: { query: "eth", limit: 15, live: true, tags: ["a"] } },
  );
  assert.deepEqual(parseArgValues(fields, { query: "eth", limit: "", live: "", tags: "" }), {
    arguments: { query: "eth" },
  });
  assert.deepEqual(parseArgValues(fields, { query: "", limit: "", live: "", tags: "" }), {
    error: "query is required.",
  });
  assert.deepEqual(parseArgValues(fields, { query: "eth", limit: "1.5", live: "", tags: "" }), {
    error: "limit must be a whole number.",
  });
});

test("a lone arguments field must be a JSON object", () => {
  const fields = fieldsFromSchema({ type: "object" });
  assert.deepEqual(emptyArgValues(fields), { arguments: "{}" });
  assert.deepEqual(parseArgValues(fields, { arguments: '{"query":"eth"}' }), {
    arguments: { query: "eth" },
  });
  assert.deepEqual(parseArgValues(fields, { arguments: "[]" }), {
    error: "arguments must be a JSON object.",
  });
});
