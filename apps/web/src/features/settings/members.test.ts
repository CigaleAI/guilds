import assert from "node:assert/strict";
import { test } from "node:test";
import { assignableRoles, canChangeMember, canManageMembers } from "./members";

test("owners and admins manage members", () => {
  assert.equal(canManageMembers("owner"), true);
  assert.equal(canManageMembers("admin"), true);
  assert.equal(canManageMembers("member"), false);
});

test("admins cannot hand out or touch the owner role", () => {
  assert.deepEqual(assignableRoles("owner"), ["owner", "admin", "member"]);
  assert.deepEqual(assignableRoles("admin"), ["admin", "member"]);
  assert.deepEqual(assignableRoles("member"), []);
  assert.equal(canChangeMember("admin", "owner", false), false);
  assert.equal(canChangeMember("admin", "member", false), true);
  assert.equal(canChangeMember("owner", "owner", false), true);
});

test("nobody changes their own membership from the list", () => {
  assert.equal(canChangeMember("owner", "owner", true), false);
  assert.equal(canChangeMember("admin", "member", true), false);
});
