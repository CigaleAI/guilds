import assert from "node:assert/strict";
import { test } from "node:test";
import { stampAfter } from "../../src/db/pg.js";

test("stampAfter keeps a later now and advances a tie", () => {
  const at = new Date("2026-09-19T10:00:00.000Z");
  assert.equal(stampAfter(null, at).getTime(), at.getTime());
  assert.equal(stampAfter(at, new Date(at.getTime() + 5)).getTime(), at.getTime() + 5);
  assert.equal(stampAfter(at, at).getTime(), at.getTime() + 1);
});
