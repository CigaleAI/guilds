import { isJsonObject, type JsonObject } from "../lib/json.js";

export const OWNER_SCOPES = ["platform", "org", "guild", "agent"] as const;
export type OwnerScope = (typeof OWNER_SCOPES)[number];
export const MCP_AUTH = ["none", "token", "oauth"] as const;
export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SECRET_DESCRIPTION_MAX = 400;

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

export function isOwnerScope(value: string): value is OwnerScope {
  return OWNER_SCOPES.some((scope) => scope === value);
}

export function validateOwner(
  ownerScope: string,
  ownerId: string | null | undefined,
): [OwnerScope, string | null] {
  if (!isOwnerScope(ownerScope)) {
    throw new CredentialError("owner_scope must be platform, org, guild, or agent");
  }
  if (ownerScope === "platform") {
    if (ownerId !== null && ownerId !== undefined) {
      throw new CredentialError("platform owners must not have owner_id");
    }
    return [ownerScope, null];
  }
  if (!ownerId) {
    throw new CredentialError(`${ownerScope} owners require owner_id`);
  }
  return [ownerScope, ownerId];
}

export function validateSecretName(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) {
    throw new CredentialError("name is required");
  }
  const token = name.trim();
  if (!SECRET_NAME.test(token)) {
    throw new CredentialError("name must be an environment variable name");
  }
  return token;
}

export function validateSecretDescription(value: unknown): string {
  if (typeof value !== "string") {
    throw new CredentialError("description must be a string");
  }
  const text = value.trim();
  if (!text) {
    throw new CredentialError("description must contain non-whitespace text");
  }
  if (text.length > SECRET_DESCRIPTION_MAX) {
    throw new CredentialError(`description must be at most ${SECRET_DESCRIPTION_MAX} characters`);
  }
  return text;
}

/** The payload a secret is stored as: its value. */
export type SecretPayload = { value: string };

/**
 * A secret's stored payload: the value without the whitespace around it, which a paste picks up
 * and no token carries. Whitespace inside the value is kept.
 */
export function secretPayload(value: unknown): SecretPayload {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new CredentialError("value must contain non-whitespace text");
  }
  return { value: text };
}

export function secretValue(payload: JsonObject): string {
  const value = payload.value;
  if (typeof value !== "string" || value === "") {
    throw new CredentialError("secret payload must carry a value");
  }
  return value;
}

/** A credential payload from its decrypted JSON text: the JSON object it holds. */
export function parsePayload(text: string): JsonObject {
  const loaded: unknown = JSON.parse(text);
  if (!isJsonObject(loaded)) {
    throw new CredentialError("payload must be an object");
  }
  return loaded;
}
