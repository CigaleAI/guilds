import assert from "node:assert/strict";
import { test } from "node:test";
import { showBrowserLoginStrip } from "./BrowserLoginStrip";

const shown = (patch: Partial<Parameters<typeof showBrowserLoginStrip>[0]> = {}) =>
  showBrowserLoginStrip({
    done: false,
    applyOpen: false,
    applyPending: false,
    agentId: "a_watcher",
    browserLogins: ["a_watcher"],
    ...patch,
  });

test("the strip shows only after a recipe apply deferred this agent's login", () => {
  assert.equal(shown(), true);
  assert.equal(shown({ browserLogins: [] }), false);
  assert.equal(shown({ agentId: "a_writer", browserLogins: ["a_watcher"] }), false);
});

test("the strip waits while the checklist is open or the apply is loading", () => {
  assert.equal(shown({ applyOpen: true }), false);
  assert.equal(shown({ applyPending: true }), false);
});

test("mark as done hides the strip", () => {
  assert.equal(shown({ done: true }), false);
});
