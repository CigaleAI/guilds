import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ModelKeyRequiredError,
  assertOrgModelKey,
  keyHint,
  validateModelProvider,
} from "../../src/llm/org-keys.js";

test("keyHint keeps the last four characters", () => {
  assert.equal(keyHint("sk-or-v1-abcdef"), "cdef");
  assert.equal(keyHint("ab"), "ab");
});

test("validateModelProvider accepts catalog providers", () => {
  assert.equal(validateModelProvider("openrouter"), "openrouter");
  assert.equal(validateModelProvider("deepinfra"), "deepinfra");
  assert.equal(validateModelProvider("kimi"), "kimi");
  assert.throws(() => validateModelProvider("openai"), /unknown model provider/);
});

test("a coding-API model needs the organisation's own key", async () => {
  const none = { resolveOrgApiKey: async () => null };
  const connected = { resolveOrgApiKey: async () => "org-kimi" };
  await assertOrgModelKey(none, "org_1", "openrouter/openai/gpt-5.6-luna");
  await assertOrgModelKey(connected, "org_1", "kimi/kimi-for-coding");
  await assert.rejects(
    () => assertOrgModelKey(none, "org_1", "kimi/kimi-for-coding"),
    (error: unknown) => error instanceof ModelKeyRequiredError && error.status === 422 && error.provider === "kimi",
  );
});
