import assert from "node:assert/strict";
import { test } from "node:test";
import { cappedCount } from "./CountBadge";

test("a count shows as it is up to 99, then as 99+", () => {
  assert.equal(cappedCount(1), "1");
  assert.equal(cappedCount(99), "99");
  assert.equal(cappedCount(100), "99+");
});
