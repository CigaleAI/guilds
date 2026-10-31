import assert from "node:assert/strict";
import { test } from "node:test";
import { showBrowserLoginStrip } from "./BrowserLoginStrip";

test("the strip shows only after a recipe apply deferred this agent's login", () => {
  assert.equal(showBrowserLoginStrip("a_watcher", ["a_watcher"], false, false), true);
  assert.equal(showBrowserLoginStrip("a_watcher", [], false, false), false);
  assert.equal(showBrowserLoginStrip("a_writer", ["a_watcher"], false, false), false);
});

test("the strip waits while the guild's apply is in progress", () => {
  assert.equal(showBrowserLoginStrip("a_watcher", ["a_watcher"], false, true), false);
});

test("mark as done hides the strip", () => {
  assert.equal(showBrowserLoginStrip("a_watcher", ["a_watcher"], true, false), false);
});
