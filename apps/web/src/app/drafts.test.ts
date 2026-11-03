import assert from "node:assert/strict";
import { test } from "node:test";
import { draftAfterSave } from "./drafts";

test("a draft that still holds the saved text is cleared", () => {
  assert.equal(draftAfterSave("Plan", "Plan"), null);
});

test("a draft typed on while the save ran is kept", () => {
  assert.equal(draftAfterSave("Plan more", "Plan"), "Plan more");
});

test("a draft discarded while the save ran stays discarded", () => {
  assert.equal(draftAfterSave(null, "Plan"), null);
});
