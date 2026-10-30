import assert from "node:assert/strict";
import { test } from "node:test";
import { isOAuthStrategy, isToolStart } from "./catalogEdits";

test("an_oauth_strategy_is_none_dynamic_or_configured", () => {
  assert.equal(isOAuthStrategy("dynamic"), true);
  assert.equal(isOAuthStrategy("configured"), true);
  assert.equal(isOAuthStrategy("none"), true);
  assert.equal(isOAuthStrategy("implicit"), false);
});

test("a_tool_starts_as_its_connector_says_on_or_off", () => {
  assert.equal(isToolStart("manifest"), true);
  assert.equal(isToolStart("on"), true);
  assert.equal(isToolStart("off"), true);
  assert.equal(isToolStart("default"), false);
});
