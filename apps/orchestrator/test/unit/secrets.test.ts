import assert from "node:assert/strict";
import { test } from "node:test";
import { MissingSecretError, redact, resolveSecrets } from "../../src/secrets/index.js";

test("resolveSecrets reads selected names", () => {
  const env = { BRAVE_API_KEY: "brave-secret", OTHER: "ignored" };
  assert.deepEqual(resolveSecrets(["BRAVE_API_KEY"], env), { BRAVE_API_KEY: "brave-secret" });
});

test("missing secret is a run-start error", () => {
  assert.throws(() => resolveSecrets(["MISSING_SECRET"], {}), (error: unknown) => {
    assert.ok(error instanceof MissingSecretError);
    assert.equal(error.message, "secret MISSING_SECRET is not set");
    return true;
  });
});

test("redact replaces longest values first", () => {
  assert.equal(
    redact("ab-abcdef and ab", { SHORT: "ab", LONG: "abcdef" }),
    "[REDACTED:SHORT]-[REDACTED:LONG] and [REDACTED:SHORT]",
  );
});
