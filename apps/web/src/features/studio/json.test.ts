import assert from "node:assert/strict";
import { test } from "node:test";
import { isPlainRecord } from "./json";

test("a JSON object with named fields is a plain record", () => {
  assert.equal(isPlainRecord({ widget: "studio_edit_request" }), true);
  assert.equal(isPlainRecord({}), true);
});

test("null, an array, and a scalar are not plain records", () => {
  assert.equal(isPlainRecord(null), false);
  assert.equal(isPlainRecord([1, 2]), false);
  assert.equal(isPlainRecord("text"), false);
  assert.equal(isPlainRecord(4), false);
});
