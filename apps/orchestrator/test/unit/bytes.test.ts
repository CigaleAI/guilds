import assert from "node:assert/strict";
import { test } from "node:test";
import { capBytes } from "../../src/lib/bytes.js";

test("cap_bytes noop when under limit", () => {
  const [text, truncated] = capBytes("hello", 100);
  assert.equal(text, "hello");
  assert.equal(truncated, false);
});

test("capBytes cuts the text to the byte limit and marks the cut", () => {
  const [text, truncated] = capBytes("a".repeat(100), 20);
  assert.equal(text, `${"a".repeat(8)}\n[truncated]`);
  assert.equal(Buffer.byteLength(text, "utf8"), 20);
  assert.equal(truncated, true);
});
