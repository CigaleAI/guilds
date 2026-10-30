import assert from "node:assert/strict";
import { test } from "node:test";
import { visiblePanes } from "./media";

test("a wide screen shows the list beside the item", () => {
  assert.deepEqual(visiblePanes(true, true, true), { list: true, item: true });
  assert.deepEqual(visiblePanes(true, false, false), { list: true, item: true });
});

test("a phone shows the list while it is open, and the item once it is closed", () => {
  assert.deepEqual(visiblePanes(false, true, true), { list: true, item: false });
  assert.deepEqual(visiblePanes(false, false, true), { list: false, item: true });
});

test("a phone shows the list when nothing is open", () => {
  assert.deepEqual(visiblePanes(false, false, false), { list: true, item: false });
});
