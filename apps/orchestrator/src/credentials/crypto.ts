import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { decodeMasterKey } from "../config/index.js";
import { dumpsCompact } from "../lib/json.js";
import { CredentialError } from "./validate.js";

export function loadMasterKey(value?: string | null): Buffer {
  const raw = value === undefined || value === null ? process.env.SECRETS_MASTER_KEY : value;
  return decodeMasterKey(raw ?? "");
}

export function asBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  throw new CredentialError("payload must be bytes");
}

export function encryptPayload(
  payload: Record<string, unknown>,
  key?: Buffer | undefined,
  nonce?: Buffer | undefined,
): [Buffer, Buffer] {
  const master = key ?? loadMasterKey();
  const usedNonce = nonce ?? randomBytes(12);
  const plaintext = Buffer.from(dumpsCompact(payload, true), "utf8");
  const cipher = createCipheriv("aes-256-gcm", master, usedNonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [Buffer.concat([encrypted, tag]), usedNonce];
}

export function decryptPayload(
  ciphertext: Buffer,
  nonce: Buffer,
  key?: Buffer | undefined,
): Record<string, unknown> {
  const master = key ?? loadMasterKey();
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", master, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  const loaded: unknown = JSON.parse(plaintext);
  if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) {
    throw new CredentialError("payload must be an object");
  }
  return loaded as Record<string, unknown>;
}

export function environmentFingerprint(
  values: Record<string, string>,
  key?: Buffer | undefined,
): string {
  const payload = dumpsCompact(
    Object.entries(values).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    false,
  );
  const bytes = Buffer.from(payload, "utf8");
  let digest: string;
  if (Object.keys(values).length === 0) {
    digest = createHash("sha256").update(bytes).digest("hex");
  } else {
    const master = key ?? loadMasterKey();
    digest = createHmac("sha256", master).update(bytes).digest("hex");
  }
  return digest.slice(0, 63);
}
