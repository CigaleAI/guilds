import assert from "node:assert/strict";
import { test } from "node:test";
import { agentHandleError, handleError, handleHint, liveHandleError } from "./names";

test("an empty handle is not yet an error", () => {
  assert.equal(handleError(""), undefined);
  assert.equal(agentHandleError(""), undefined);
});

test("a handle must be lowercase letters, digits and hyphens, starting with a letter", () => {
  assert.equal(handleError("research"), undefined);
  assert.equal(handleError("lab-2"), undefined);
  assert.equal(handleError("Research"), handleHint);
  assert.equal(handleError("1lab"), handleHint);
  assert.equal(handleError("lab_name"), handleHint);
});

test("user is reserved as an agent handle", () => {
  assert.equal(agentHandleError("user"), "Reserved for tagging every operator.");
  assert.equal(handleError("user"), undefined);
});

test("live handle errors stay quiet until the operator has started, then follow as they type", () => {
  assert.equal(liveHandleError("", false), undefined);
  assert.equal(liveHandleError("", true), handleHint);
  assert.equal(liveHandleError("Lab", true), handleHint);
  assert.equal(liveHandleError("lab", true), undefined);
  assert.equal(liveHandleError("user", true, "agent"), "Reserved for tagging every operator.");
  assert.equal(liveHandleError("user", true, "guild"), undefined);
});
