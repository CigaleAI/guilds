import assert from "node:assert/strict";
import { test } from "node:test";
import { guildInitials } from "./guilds";

test("guild initials take the first letter of two words, else two letters", () => {
  assert.equal(guildInitials("degen-captial"), "DC");
  assert.equal(guildInitials("Link Prospection"), "LP");
  assert.equal(guildInitials("x-replies"), "XR");
  assert.equal(guildInitials("studio"), "ST");
});
