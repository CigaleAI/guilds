import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInputSchema } from "./toolSchema";

test("a_json_object_parses_to_the_schema", () => {
  assert.deepEqual(parseInputSchema('{"type":"object","properties":{}}'), {
    schema: { type: "object", properties: {} },
  });
});

test("text_that_is_not_json_reports_the_parse_error", () => {
  const parsed = parseInputSchema('{"type":');
  assert.ok("error" in parsed);
  assert.match(parsed.error, /JSON/);
});

test("json_that_is_not_an_object_asks_for_one", () => {
  assert.deepEqual(parseInputSchema("[1, 2]"), { error: "A JSON object." });
  assert.deepEqual(parseInputSchema("null"), { error: "A JSON object." });
});
