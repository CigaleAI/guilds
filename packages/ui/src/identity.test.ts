import assert from "node:assert/strict";
import { test } from "node:test";
import { identityToneOf, initialsOf, personTone } from "./identity";

test("a palette hex is recognised with surrounding space", () => {
  assert.equal(identityToneOf(" #B8627F "), "rosewood");
});

test("colours from the earlier palette keep their hue", () => {
  assert.equal(identityToneOf("#7c5cff"), "dusk");
  assert.equal(identityToneOf("#ff4d8d"), "rosewood");
  assert.equal(identityToneOf("#3b82f6"), "signal");
  assert.equal(identityToneOf("#14b8a6"), "tide");
  assert.equal(identityToneOf("#fbbf24"), "ochre");
  assert.equal(identityToneOf("#a3e635"), "moss");
});

test("any other colour takes the nearest palette colour; junk falls back to dusk", () => {
  assert.equal(identityToneOf("#00c8ff"), "signal");
  assert.equal(identityToneOf("#6b8e23"), "moss");
  assert.equal(identityToneOf("#808080"), "dusk");
  assert.equal(identityToneOf("not a colour"), "dusk");
});

test("a person has a tone only once they choose a colour", () => {
  assert.equal(personTone(null), undefined);
  assert.equal(personTone(undefined), undefined);
  assert.equal(personTone(""), undefined);
  assert.equal(personTone("#1fafd1"), "signal");
});

test("initials are the handle's first two characters", () => {
  assert.equal(initialsOf("managooor"), "MA");
  assert.equal(initialsOf(" x-access"), "X-");
});
