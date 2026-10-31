import assert from "node:assert/strict";
import { test } from "node:test";
import { AppWiringError } from "./wiring";

test("a wiring fault is an error named for the app's assembly", () => {
  const error = new AppWiringError("index.html has no #root element");
  assert.ok(error instanceof Error);
  assert.equal(error.name, "AppWiringError");
  assert.equal(error.message, "index.html has no #root element");
});
