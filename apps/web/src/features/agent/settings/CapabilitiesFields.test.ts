import assert from "node:assert/strict";
import { test } from "node:test";
import { blockedCapabilities } from "./CapabilitiesFields";
import { configFormOf, defaultAgentConfig } from "./configForm";

const form = configFormOf(defaultAgentConfig);
const tiny = { cpu: 0.1, memory_mib: 64 };
const large = { cpu: 64, memory_mib: 262144 };

test("a machine too small for Browser and Coding blocks both while they are off, Coding first", () => {
  assert.deepEqual(
    blockedCapabilities(form, tiny, true).map((item) => item.what),
    ["Coding", "Browser"],
  );
});

test("a capability already on, or a Coding card the form leaves out, is not blocked", () => {
  assert.deepEqual(
    blockedCapabilities({ ...form, browser: true }, tiny, false).map((item) => item.what),
    [],
  );
  assert.deepEqual(
    blockedCapabilities({ ...form, coding: true }, tiny, true).map((item) => item.what),
    ["Browser"],
  );
});

test("nothing is blocked on a machine that fits, or before one is chosen", () => {
  assert.deepEqual(blockedCapabilities(form, large, true), []);
  assert.deepEqual(blockedCapabilities(form, undefined, true), []);
});
