import assert from "node:assert/strict";
import { test } from "node:test";
import { openingScope, scopeOfDisplayPath } from "./displayPath";

test("a display path tells its scope", () => {
  assert.equal(scopeOfDisplayPath("org/o/agents/a/files/x.bin"), "agent");
  assert.equal(scopeOfDisplayPath("org/o/guilds/g/notes.md"), "guild");
  assert.equal(scopeOfDisplayPath("org/o/schema.md"), "org");
});

const scopes = [{ id: "agent" }, { id: "guild" }];

test("a browser opens on the scope of the path it shows first", () => {
  assert.equal(openingScope(scopes, "org/o/agents/a/files/x.bin"), scopes[0]);
  assert.equal(openingScope(scopes, "org/o/guilds/g/notes.md"), scopes[1]);
});

test("a browser has no opening scope without a path, or for a scope it does not offer", () => {
  assert.equal(openingScope(scopes, undefined), undefined);
  assert.equal(openingScope(scopes, ""), undefined);
  assert.equal(openingScope(scopes, "org/o/schema.md"), undefined);
});
