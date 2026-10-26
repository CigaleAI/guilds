import assert from "node:assert/strict";
import { test } from "node:test";
import { scopeOfDisplayPath } from "./displayPath";

test("a display path tells its scope", () => {
  assert.equal(scopeOfDisplayPath("org/o/agents/a/files/x.bin"), "agent");
  assert.equal(scopeOfDisplayPath("org/o/guilds/g/notes.md"), "guild");
  assert.equal(scopeOfDisplayPath("org/o/schema.md"), "org");
});
