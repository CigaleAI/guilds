import { SLUG_PATTERN } from "../db/schema/index.js";
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * A registry's index: what it offers, one entry per published version. `path` is the package's
 * location relative to the index; `sha256` and `size` are the package's bytes, which the client
 * checks before it reads them.
 */

const Hash = Type.String({ pattern: "^[0-9a-f]{64}$" });
const Version = Type.String({ pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$" });
const RelativePath = Type.String({ pattern: "^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$" });

const ConnectorEntry = Type.Object({
  slug: Type.String({ pattern: SLUG_PATTERN }),
  version: Version,
  path: RelativePath,
  sha256: Hash,
  size: Type.Integer({ minimum: 1 }),
  publisher: Type.String(),
  verified: Type.Boolean(),
  /** The publisher's mark for a connector still being tried out; an install accepts it explicitly. */
  experimental: Type.Optional(Type.Boolean()),
  display_name: Type.String({ minLength: 1 }),
  description: Type.String(),
});

const RecipeEntry = Type.Object({
  name: Type.String({ pattern: "^[a-z][a-z0-9-]{0,62}$" }),
  version: Version,
  path: RelativePath,
  sha256: Hash,
  size: Type.Integer({ minimum: 1 }),
  publisher: Type.String(),
  verified: Type.Boolean(),
  display_name: Type.String({ minLength: 1 }),
  description: Type.String(),
});

export const RegistryIndexSchema = Type.Object({
  generated_at: Type.String({ minLength: 1 }),
  connectors: Type.Array(ConnectorEntry),
  recipes: Type.Array(RecipeEntry),
  /** Base64 Ed25519 signature over the index's canonical bytes without this field. */
  signature: Type.Optional(Type.String({ minLength: 1 })),
});

export type RegistryIndex = Static<typeof RegistryIndexSchema>;
export type RegistryConnectorEntry = Static<typeof ConnectorEntry>;
export type RegistryRecipeEntry = Static<typeof RecipeEntry>;

export class RegistryError extends Error {
  status: number;

  constructor(message: string, status = 422) {
    super(message);
    this.name = "RegistryError";
    this.status = status;
  }
}

/** Checks a parsed index; throws `RegistryError` naming the first problem. */
export function parseIndex(raw: unknown): RegistryIndex {
  if (!Value.Check(RegistryIndexSchema, raw)) {
    const first = Value.Errors(RegistryIndexSchema, raw).First();
    throw new RegistryError(`registry index ${first ? `${first.path || "/"}: ${first.message}` : "is invalid"}`, 502);
  }
  return raw;
}

function versionParts(version: string): number[] {
  return version.split(".").map(Number);
}

/** Orders two `major.minor.patch` versions: negative when `a` is older. */
export function compareVersions(a: string, b: string): number {
  const [left, right] = [versionParts(a), versionParts(b)];
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/** The entry `version` names, or the newest when it names none; null when the index has none. */
export function pickEntry<E extends { version: string }>(entries: readonly E[], version?: string): E | null {
  if (version) {
    return entries.find((entry) => entry.version === version) ?? null;
  }
  return [...entries].sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;
}

/** Each name's newest entry, with every version the index offers for it. */
export function latestEntries<E extends { version: string }>(
  entries: readonly E[],
  nameOf: (entry: E) => string,
): Array<E & { versions: string[] }> {
  const byName = new Map<string, E[]>();
  for (const entry of entries) {
    byName.set(nameOf(entry), [...(byName.get(nameOf(entry)) ?? []), entry]);
  }
  return [...byName.values()]
    .map((versions) => {
      const sorted = [...versions].sort((a, b) => compareVersions(b.version, a.version));
      return { ...sorted[0]!, versions: sorted.map((entry) => entry.version) };
    })
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
}

/** JSON with every object's keys sorted and no whitespace: the bytes a signature covers. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function unsignedBytes(index: RegistryIndex): Buffer {
  const { signature: _signature, ...rest } = index;
  return Buffer.from(canonicalJson(rest), "utf8");
}

/** An Ed25519 public key from base64 SPKI DER, as `REGISTRY_PUBLIC_KEY` holds it. */
export function registryPublicKey(base64: string): KeyObject {
  try {
    const key = createPublicKey({ key: Buffer.from(base64, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error("not an Ed25519 key");
    }
    return key;
  } catch (error) {
    throw new RegistryError(`REGISTRY_PUBLIC_KEY is not an Ed25519 public key: ${error instanceof Error ? error.message : String(error)}`, 500);
  }
}

/** Signs an index with an Ed25519 private key in base64 PKCS#8 DER; returns it with `signature` set. */
export function signIndex(index: RegistryIndex, privateKeyBase64: string): RegistryIndex {
  const key = createPrivateKey({ key: Buffer.from(privateKeyBase64, "base64"), format: "der", type: "pkcs8" });
  return { ...index, signature: sign(null, unsignedBytes(index), key).toString("base64") };
}

/** Refuses an index that carries no signature, or one `key` does not verify. */
export function assertSigned(index: RegistryIndex, key: KeyObject): void {
  if (!index.signature) {
    throw new RegistryError("registry index is unsigned, and this box requires a signature", 502);
  }
  if (!verify(null, unsignedBytes(index), key, Buffer.from(index.signature, "base64"))) {
    throw new RegistryError("registry index signature does not verify with REGISTRY_PUBLIC_KEY", 502);
  }
}
