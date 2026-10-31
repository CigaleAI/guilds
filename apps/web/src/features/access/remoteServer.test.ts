import assert from "node:assert/strict";
import { test } from "node:test";
import { isRemoteServerAuth } from "./remoteServer";

test("a_remote_server_signs_in_with_none_a_token_or_oauth", () => {
  assert.equal(isRemoteServerAuth("none"), true);
  assert.equal(isRemoteServerAuth("token"), true);
  assert.equal(isRemoteServerAuth("oauth"), true);
});

test("any_other_value_is_no_way_to_sign_in", () => {
  assert.equal(isRemoteServerAuth("password"), false);
  assert.equal(isRemoteServerAuth(""), false);
});
