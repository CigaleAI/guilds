import assert from "node:assert/strict";
import { test } from "node:test";
import { isGuildAdmin } from "./permissions";

test("only an admin operator of the guild is its admin", () => {
  const guild = {
    operators: [
      { user_id: "u_1", name: "emma", role: "admin" as const },
      { user_id: "u_2", name: "sam", role: "operator" as const },
    ],
  };
  assert.equal(isGuildAdmin(guild, "u_1"), true);
  assert.equal(isGuildAdmin(guild, "u_2"), false);
  assert.equal(isGuildAdmin(guild, "u_3"), false);
});
