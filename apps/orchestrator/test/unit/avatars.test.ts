import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_AVATAR_COLOR, DEFAULT_AVATAR_SHAPE } from "../../src/avatars/clay.js";
import {
  normalizeAvatarColor,
  normalizeAvatarShape,
  parseAvatarShape,
  renderAvatarFromShape,
  renderAvatarSvg,
  SUPPORTED_AVATAR_STYLES,
} from "../../src/avatars/index.js";

test("a shape is stored trimmed and lowercased, and a blank one is the default", () => {
  assert.equal(normalizeAvatarShape("  Critters:Bell-1 "), "critters:bell-1");
  assert.equal(normalizeAvatarShape(""), DEFAULT_AVATAR_SHAPE);
  assert.equal(normalizeAvatarShape(undefined), DEFAULT_AVATAR_SHAPE);
});

test("a shape that is not one normalizes to null", () => {
  assert.equal(normalizeAvatarShape("no spaces"), null);
  assert.equal(normalizeAvatarShape("x".repeat(64)), null);
});

test("a colour is stored trimmed and lowercased, and a blank one is the default", () => {
  assert.equal(normalizeAvatarColor(" #FF4D8D "), "#ff4d8d");
  assert.equal(normalizeAvatarColor(null), DEFAULT_AVATAR_COLOR);
});

test("a colour that is not a 6-digit hex normalizes to null", () => {
  assert.equal(normalizeAvatarColor("#fff"), null);
  assert.equal(normalizeAvatarColor("red"), null);
});

test("parseAvatarShape extracts style and seed correctly", () => {
  assert.deepEqual(parseAvatarShape("critters:bell-preview"), {
    style: "critters",
    seed: "bell-preview",
  });
  assert.deepEqual(parseAvatarShape("cameo:profile-1"), {
    style: "cameo",
    seed: "profile-1",
  });
  assert.deepEqual(parseAvatarShape("pixelbot:bot-42"), {
    style: "pixelbot",
    seed: "bot-42",
  });
  assert.deepEqual(parseAvatarShape("cutouts:paper-1"), {
    style: "cutouts",
    seed: "paper-1",
  });
  assert.deepEqual(parseAvatarShape("voxel-bot:cube-9"), {
    style: "voxel-bot",
    seed: "cube-9",
  });
  assert.deepEqual(parseAvatarShape("bottts-neutral:sparky"), {
    style: "bottts-neutral",
    seed: "sparky",
  });
  assert.deepEqual(parseAvatarShape("clay:cube-1"), {
    style: "clay",
    seed: "cube-1",
  });
  // Prefix with hyphen
  assert.deepEqual(parseAvatarShape("critters-test"), {
    style: "critters",
    seed: "test",
  });
  assert.deepEqual(parseAvatarShape("bottts-neutral-cat"), {
    style: "bottts-neutral",
    seed: "cat",
  });
  assert.deepEqual(parseAvatarShape("voxel-bot-cube"), {
    style: "voxel-bot",
    seed: "cube",
  });
  // Legacy shape names default to clay
  assert.deepEqual(parseAvatarShape("teardrop"), {
    style: "clay",
    seed: "teardrop",
  });
  assert.deepEqual(parseAvatarShape("blob"), {
    style: "clay",
    seed: "blob",
  });
  assert.deepEqual(parseAvatarShape(""), {
    style: "clay",
    seed: "teardrop",
  });
  assert.deepEqual(parseAvatarShape(null), {
    style: "clay",
    seed: "teardrop",
  });
});

test("renderAvatarSvg generates valid SVG for each supported style", () => {
  for (const style of SUPPORTED_AVATAR_STYLES) {
    const svg = renderAvatarSvg(style, "test-seed", "#3b82f6");
    assert.ok(svg.startsWith("<svg"), `${style} should start with <svg`);
    assert.ok(svg.endsWith("</svg>"), `${style} should end with </svg>`);
    assert.match(svg, /3b82f6/i, `${style} SVG should contain the passed color`);
  }
});

test("renderAvatarFromShape delegates to parsed style", () => {
  const crittersSvg = renderAvatarFromShape("critters:test-seed", "#14b8a6");
  assert.ok(crittersSvg.includes("<svg"));
  assert.match(crittersSvg, /14b8a6/i);

  const pixelbotSvg = renderAvatarFromShape("pixelbot:robot-99", "#ff4d8d");
  assert.ok(pixelbotSvg.includes("<svg"));
  assert.match(pixelbotSvg, /ff4d8d/i);

  const cutoutsSvg = renderAvatarFromShape("cutouts:paper-1", "#1fafd1");
  assert.ok(cutoutsSvg.includes("<svg"));
  assert.match(cutoutsSvg, /1fafd1/i);

  const voxelSvg = renderAvatarFromShape("voxel-bot:cube-9", "#7c5cff");
  assert.ok(voxelSvg.includes("<svg"));
  assert.match(voxelSvg, /7c5cff/i);
});
