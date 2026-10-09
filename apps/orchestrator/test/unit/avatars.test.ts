import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseAvatarShape,
  renderAvatarFromShape,
  renderAvatarSvg,
  SUPPORTED_AVATAR_STYLES,
} from "../../src/avatars/index.js";

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
});
