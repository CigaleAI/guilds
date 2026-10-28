import assert from "node:assert/strict";
import { test } from "node:test";
import { agentsOfRoles } from "../../src/recipes/access.js";

test("agentsOfRoles skips a role apply did not create", () => {
  assert.deepEqual(agentsOfRoles(["writer", "ghost"], new Map([["writer", "a_writer"]])), [
    "a_writer",
  ]);
});
