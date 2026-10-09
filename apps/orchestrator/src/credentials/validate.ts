export const OWNER_SCOPES = ["platform", "org", "guild", "agent"] as const;
export const MCP_AUTH = ["none", "token", "oauth"] as const;
export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SECRET_DESCRIPTION_MAX = 400;

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

export function ownerRefs(
  ownerScope: string,
  ownerId: string | null | undefined,
): [string | null, string | null, string | null] {
  if (ownerScope === "platform") {
    return [null, null, null];
  }
  if (ownerScope === "org") {
    return [ownerId ?? null, null, null];
  }
  if (ownerScope === "guild") {
    return [null, ownerId ?? null, null];
  }
  return [null, null, ownerId ?? null];
}

export function validateOwner(
  ownerScope: string,
  ownerId: string | null | undefined,
): [string, string | null] {
  if (!(OWNER_SCOPES as readonly string[]).includes(ownerScope)) {
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

export function secretPayload(value: unknown): { value: string } {
  if (typeof value !== "string" || value === "") {
    throw new CredentialError("value must be a non-empty string");
  }
  return { value };
}

export function secretValue(payload: Record<string, unknown>): string {
  const value = payload.value;
  if (typeof value !== "string" || value === "") {
    throw new CredentialError("secret payload must carry a value");
  }
  return value;
}
