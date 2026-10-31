import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../api/client";
import { asksToConfirmReplace } from "./instanceKeys";

test("a_conflict_from_the_server_asks_to_confirm_replacing_the_keys", () => {
  assert.equal(asksToConfirmReplace(new ApiError(409, "2 GitHub logins depend on the App")), true);
});

test("any_other_failure_is_reported_as_it_is", () => {
  assert.equal(asksToConfirmReplace(new ApiError(400, "A value is missing")), false);
  assert.equal(asksToConfirmReplace(new Error("Failed to fetch")), false);
});
