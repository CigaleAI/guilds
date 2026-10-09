import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { decodeMasterKey } from "../../src/config/index.js";
import { decryptPayload, encryptPayload, environmentFingerprint } from "../../src/credentials/crypto.js";
import { dumpsCompact } from "../../src/lib/json.js";
import { loadJsonFixture } from "../helpers/fixtures.js";

const vectors = loadJsonFixture<{
  aes_gcm: {
    key_b64: string;
    nonce_b64: string;
    plaintext: Record<string, unknown>;
    plaintext_utf8: string;
    ciphertext_b64: string;
    roundtrip: Record<string, unknown>;
  };
  key_decode: Record<string, { ok: boolean; hex?: string; error?: string }>;
  fingerprint: {
    empty: string;
    ordered: string;
    reordered: string;
    changed: string;
    unicode: string;
    length: number;
  };
}>("crypto/vectors.json");

const FIXED_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index));

function tryKey(raw: string): { ok: boolean; hex?: string; error?: string } {
  try {
    return { ok: true, hex: decodeMasterKey(raw).toString("hex") };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function assertKey(actual: { ok: boolean; hex?: string; error?: string }, expected: { ok: boolean; hex?: string; error?: string }) {
  assert.equal(actual.ok, expected.ok);
  if (expected.ok) {
    assert.equal(actual.hex, expected.hex);
    return;
  }
  const message = expected.error ?? "";
  const detail = message.includes(": ") ? message.slice(message.indexOf(": ") + 2) : message;
  assert.match(actual.error ?? "", new RegExp(detail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

test("AES-GCM encrypt and decrypt match the recorded vectors", () => {
  const key = Buffer.from(vectors.aes_gcm.key_b64, "base64");
  const nonce = Buffer.from(vectors.aes_gcm.nonce_b64, "base64");
  assert.equal(dumpsCompact(vectors.aes_gcm.plaintext, true), vectors.aes_gcm.plaintext_utf8);
  const [ciphertext] = encryptPayload(vectors.aes_gcm.plaintext, key, nonce);
  assert.equal(ciphertext.toString("base64"), vectors.aes_gcm.ciphertext_b64);
  assert.deepEqual(decryptPayload(ciphertext, nonce, key), vectors.aes_gcm.roundtrip);
  const recorded = Buffer.from(vectors.aes_gcm.ciphertext_b64, "base64");
  assert.deepEqual(decryptPayload(recorded, nonce, key), vectors.aes_gcm.roundtrip);
});

test("master key decode positives and negatives match the recorded outcomes", () => {
  const std = FIXED_KEY.toString("base64");
  const url = FIXED_KEY.toString("base64url");
  const hex = FIXED_KEY.toString("hex");
  const hexWs = hex.match(/.{2}/g)?.join(" ") ?? hex;
  const ascii = "abcdefghijklmnopqrstuvwxyz123456";
  assertKey(tryKey(std), vectors.key_decode.strict_b64 ?? { ok: false });
  assertKey(tryKey(url), vectors.key_decode.urlsafe_b64 ?? { ok: false });
  assertKey(tryKey(hex), vectors.key_decode.hex ?? { ok: false });
  assertKey(tryKey(hexWs), vectors.key_decode.hex_whitespace ?? { ok: false });
  assertKey(tryKey(ascii), vectors.key_decode.ascii_32 ?? { ok: false });
  assertKey(tryKey("too-short"), vectors.key_decode.too_short ?? { ok: false });
  assertKey(tryKey("zzzz"), vectors.key_decode.invalid_hex ?? { ok: false });
  assertKey(tryKey("00".repeat(16)), vectors.key_decode.wrong_len_hex ?? { ok: false });
  assertKey(tryKey(""), vectors.key_decode.empty ?? { ok: false });
});

test("environment fingerprints match recorded digests", () => {
  assert.equal(environmentFingerprint({}, FIXED_KEY), vectors.fingerprint.empty);
  assert.equal(environmentFingerprint({ B: "two", A: "one" }, FIXED_KEY), vectors.fingerprint.ordered);
  assert.equal(environmentFingerprint({ A: "one", B: "two" }, FIXED_KEY), vectors.fingerprint.reordered);
  assert.equal(environmentFingerprint({ A: "changed", B: "two" }, FIXED_KEY), vectors.fingerprint.changed);
  assert.equal(environmentFingerprint({ NAME: "café" }, FIXED_KEY), vectors.fingerprint.unicode);
  assert.equal(environmentFingerprint({ A: "one", B: "two" }, FIXED_KEY).length, vectors.fingerprint.length);
  const empty = dumpsCompact([], false);
  assert.equal(createHash("sha256").update(empty, "utf8").digest("hex").slice(0, 63), vectors.fingerprint.empty);
  const ordered = dumpsCompact([["A", "one"], ["B", "two"]], false);
  assert.equal(createHmac("sha256", FIXED_KEY).update(ordered, "utf8").digest("hex").slice(0, 63), vectors.fingerprint.ordered);
});
