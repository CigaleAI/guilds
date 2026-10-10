import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAvatarShape } from "../../src/avatars/index.js";
import {
  assignGuildLooks,
  assignedAvatarStyle,
  GUILD_AVATAR_STYLES,
  IDENTITY_COLORS,
  isDefaultAvatarShape,
  type RoleLook,
} from "../../src/avatars/looks.js";

function role(handle: string, shape = "teardrop", color = "#7c5cff"): RoleLook {
  return { role: handle, avatar_shape: shape, avatar_color: color };
}

function looksOf(roles: RoleLook[]): Array<[string, string]> {
  return roles.map((item) => [item.avatar_shape, item.avatar_color]);
}

test("default teardrop is not a chosen family", () => {
  assert.equal(isDefaultAvatarShape("teardrop"), true);
  assert.equal(isDefaultAvatarShape("clay:teardrop"), true);
  assert.equal(isDefaultAvatarShape(""), true);
  assert.equal(assignedAvatarStyle("teardrop"), null);
  assert.equal(assignedAvatarStyle("critters:willow"), "critters");
  assert.equal(assignedAvatarStyle("gumdrop"), "clay");
});

test("a first write with no looks picks one family and unique variants", () => {
  const roles = [role("scout"), role("archivist"), role("writer")];
  assert.equal(assignGuildLooks(roles), true);
  const family = assignedAvatarStyle(roles[0]?.avatar_shape ?? "");
  assert.ok(family && (GUILD_AVATAR_STYLES as readonly string[]).includes(family));
  const seeds = roles.map((item) => parseAvatarShape(item.avatar_shape).seed);
  const colors = roles.map((item) => item.avatar_color);
  assert.equal(new Set(roles.map((item) => assignedAvatarStyle(item.avatar_shape))).size, 1);
  assert.equal(new Set(seeds).size, 3);
  assert.deepEqual(new Set(colors), new Set(IDENTITY_COLORS.slice(0, 3)));
  for (const item of roles) {
    assert.equal(item.avatar_shape.startsWith(`${family}:`), true);
    assert.match(item.avatar_shape, /^[a-z0-9-]+:[a-z0-9]{8}$/);
  }
});

test("the same seed on every role keeps that family and uniquifies", () => {
  const roles = [
    role("scout", "critters:maple", "#1fafd1"),
    role("desk", "critters:maple", "#1fafd1"),
    role("writer", "critters:maple", "#1fafd1"),
  ];
  assert.equal(assignGuildLooks(roles), true);
  assert.deepEqual(
    roles.map((item) => assignedAvatarStyle(item.avatar_shape)),
    ["critters", "critters", "critters"],
  );
  assert.equal(new Set(roles.map((item) => parseAvatarShape(item.avatar_shape).seed)).size, 3);
  assert.equal(new Set(roles.map((item) => item.avatar_color)).size, 3);
});

test("a rewrite that omits looks keeps the previous family and seeds", () => {
  const previous = [role("scout", "cameo:iris", "#1fafd1"), role("desk", "cameo:ada", "#4a8a9c")];
  const next = [role("scout"), role("desk"), role("writer")];
  assert.equal(assignGuildLooks(next, previous), true);
  assert.equal(next[0]?.avatar_shape, "cameo:iris");
  assert.equal(next[0]?.avatar_color, "#1fafd1");
  assert.equal(next[1]?.avatar_shape, "cameo:ada");
  assert.equal(next[1]?.avatar_color, "#4a8a9c");
  assert.equal(assignedAvatarStyle(next[2]?.avatar_shape ?? ""), "cameo");
  assert.notEqual(parseAvatarShape(next[2]?.avatar_shape ?? "").seed, "iris");
  assert.notEqual(parseAvatarShape(next[2]?.avatar_shape ?? "").seed, "ada");
});

test("already unique family looks are left alone", () => {
  const roles = [
    role("scout", "voxel-bot:pilot", "#1fafd1"),
    role("desk", "voxel-bot:cube9xx", "#4a8a9c"),
  ];
  const before = looksOf(roles);
  assert.equal(assignGuildLooks(roles), false);
  assert.deepEqual(looksOf(roles), before);
});

test("a guild family on the previous roster wins over a new majority", () => {
  const previous = [
    role("scout", "cutouts:kite", "#c08f55"),
    role("desk", "cutouts:fold", "#b8627f"),
  ];
  const next = [role("scout", "clay:dollop", "#b8627f"), role("desk", "clay:pear", "#7f9a5e")];
  assignGuildLooks(next, previous);
  assert.deepEqual(
    next.map((item) => assignedAvatarStyle(item.avatar_shape)),
    ["cutouts", "cutouts"],
  );
});
