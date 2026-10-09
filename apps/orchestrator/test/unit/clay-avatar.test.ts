import assert from "node:assert/strict";
import { test } from "node:test";
import { clayAvatarSvg } from "../../src/avatars/clay.js";

test("clay avatar uses the body color and omits a background fill", () => {
  const svg = clayAvatarSvg("preview", "#7c5cff");
  assert.match(svg, /#7c5cff/i);
  assert.doesNotMatch(svg, /#ece8e2/i);
  assert.doesNotMatch(svg, /fill="#ece8e2"/i);
  assert.doesNotMatch(svg, /fill="#00000000"/i);
});

test("clay avatar body prefix pins a distinct silhouette", () => {
  const cube = clayAvatarSvg("cube-preview", "#7c5cff");
  const egg = clayAvatarSvg("egg-preview", "#7c5cff");
  assert.notEqual(cube, egg);
  assert.match(cube, /body-cube/);
  assert.match(egg, /body-egg/);
});
