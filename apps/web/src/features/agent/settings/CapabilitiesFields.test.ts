import assert from "node:assert/strict";
import { test } from "node:test";
import { blockedCapabilities } from "./CapabilitiesFields";
import { configFormOf, defaultAgentConfig } from "./configForm";

const form = configFormOf(defaultAgentConfig, "key");
const tiny = { cpu: 0.1, memory_mib: 64 };
const large = { cpu: 64, memory_mib: 262144 };

test("a machine too small for Browser blocks it while it is off", () => {
  assert.deepEqual(
    blockedCapabilities(form, tiny).map((item) => item.what),
    ["Browser"],
  );
});

test("a browser already on is not blocked", () => {
  assert.deepEqual(blockedCapabilities({ ...form, browser: true }, tiny), []);
});

test("nothing is blocked on a machine that fits, or before one is chosen", () => {
  assert.deepEqual(blockedCapabilities(form, large), []);
  assert.deepEqual(blockedCapabilities(form, undefined), []);
});
