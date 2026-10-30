import assert from "node:assert/strict";
import { test } from "node:test";
import { isThinkingLevel } from "./ModelFields";

test("a thinking level a model reasons at is a thinking level; any other value is not", () => {
  assert.equal(isThinkingLevel("medium"), true);
  assert.equal(isThinkingLevel("none"), true);
  assert.equal(isThinkingLevel("xhigh"), false);
  assert.equal(isThinkingLevel(undefined), false);
});
