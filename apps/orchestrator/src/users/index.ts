import { NAME_RE } from "../lib/names.js";
import { formatColumnTimestamp } from "../db/codecs.js";
import { normalizeEmail } from "../lib/email.js";

export const USER_HEADER = "X-Guilds-User";
export const USER_COOKIE = "guilds_user";
/** The user a fresh box starts with (`db/seed/operator.ts`). */
export const SEED_USERS = [
  {
    id: "user_operator",
    name: "operator",
    email: null as string | null,
    image: null as string | null,
  },
] as const;
export const SEED_USER_IDS = new Set<string>(SEED_USERS.map((user) => user.id));

export class UserValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserValidationError";
  }
}

export class UserIdentityError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(detail);
    this.name = "UserIdentityError";
    this.status = status;
    this.detail = detail;
  }
}

export function validateUserName(name: string): string {
  if (!NAME_RE.test(name)) {
    throw new UserValidationError("name must match ^[a-z][a-z0-9-]{0,62}$");
  }
  if (name === "user") {
    throw new UserValidationError("name 'user' is reserved");
  }
  return name;
}

/** A user's email as it is stored, trimmed and lower-cased; null is a user without one. */
export function validateUserEmail(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  const email = typeof value === "string" ? normalizeEmail(value) : null;
  if (email === null) {
    throw new UserValidationError("email must be an email address or null");
  }
  return email;
}

export function resolveUser<T extends { id: string }>(
  users: T[],
  token: string | null | undefined,
): T {
  if (token) {
    const match = users.find((row) => row.id === token);
    if (!match) {
      throw new UserIdentityError(404, "user not found");
    }
    return match;
  }
  if (users.length === 1) {
    return users[0]!;
  }
  throw new UserIdentityError(400, `${USER_HEADER} is required`);
}

function iso(value: unknown): string {
  if (typeof value === "string") {
    return value.includes("T") ? value : formatColumnTimestamp(value);
  }
  throw new TypeError("timestamp must be a string");
}

/** A person's identity colour: a 6-digit hex, stored lowercase; null clears it. */
export function validateUserColor(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^#[0-9a-f]{6}$/.test(text)) {
    throw new UserValidationError("color must be a 6-digit hex color or null");
  }
  return text;
}

export function userItem(row: {
  id: string;
  name: string;
  email?: string | null;
  image?: string | null;
  timezone?: string | null;
  color?: string | null;
  created_at: string;
  updated_at: string;
}): {
  id: string;
  name: string;
  email: string | null;
  image: string | null;
  timezone: string | null;
  color: string | null;
  created_at: string;
  updated_at: string;
} {
  return {
    id: row.id,
    name: row.name,
    email: row.email ?? null,
    image: row.image ?? null,
    timezone: row.timezone ?? null,
    color: row.color ?? null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}
