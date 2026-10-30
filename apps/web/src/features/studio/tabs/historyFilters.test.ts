import assert from "node:assert/strict";
import { test } from "node:test";
import { isRunKindFilter } from "./historyFilters";

test("every run kind and all of them are History's run kind filters", () => {
  assert.equal(isRunKindFilter("all"), true);
  assert.equal(isRunKindFilter("schedule"), true);
});

test("a value that names no run kind is not a filter", () => {
  assert.equal(isRunKindFilter("cron"), false);
  assert.equal(isRunKindFilter(""), false);
});
