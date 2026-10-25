import { NAME_RE } from "../lib/names.js";
import { iso } from "../db/views.js";

export const ORG_HEADER = "X-Guilds-Org";
export const ORG_COOKIE = "guilds_org";
export const ORG_ROLES = ["owner", "admin", "member"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];
export const ORG_NAME_MAX = 80;
/** The organisation a fresh box starts with (`db/seed/operator.ts`); its owners administer the instance. */
export const SEED_ORG_ID = "org_home";
export const SEED_ORG_NAME = "Home";
export const SEED_ORG_SLUG = "home";
export const SEED_ORG_HOME_USER_ID = "user_operator";
export const SEED_ORG_FOUNDERS = [SEED_ORG_HOME_USER_ID] as const;

export class OrgValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrgValidationError";
  }
}

export class OrgIdentityError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(detail);
    this.name = "OrgIdentityError";
    this.status = status;
    this.detail = detail;
  }
}

export function validateSlug(slug: string): string {
  if (!NAME_RE.test(slug)) {
    throw new OrgValidationError("slug must match ^[a-z][a-z0-9-]{0,62}$");
  }
  return slug;
}

export function validateOrgName(name: string): string {
  const text = (name ?? "").trim();
  if (!text) {
    throw new OrgValidationError("name is required");
  }
  if (text.length > ORG_NAME_MAX) {
    throw new OrgValidationError(`name must be at most ${ORG_NAME_MAX} characters`);
  }
  if ([...text].some((char) => char.charCodeAt(0) < 32)) {
    throw new OrgValidationError("name must not contain control characters");
  }
  return text;
}

export function validateRole(role: string): OrgRole {
  if (!(ORG_ROLES as readonly string[]).includes(role)) {
    throw new OrgValidationError("role must be owner, admin, or member");
  }
  return role as OrgRole;
}

export function resolveOrg<T extends { id: string }>(
  memberships: T[],
  token: string | null | undefined,
): T {
  if (token) {
    const match = memberships.find((row) => row.id === token);
    if (!match) {
      throw new OrgIdentityError(404, "organisation not found");
    }
    return match;
  }
  if (memberships.length === 1) {
    return memberships[0]!;
  }
  throw new OrgIdentityError(400, `${ORG_HEADER} is required`);
}

export function canManageMembers(role: string): boolean {
  return role === "owner" || role === "admin";
}

export function canManageOwners(role: string): boolean {
  return role === "owner";
}

export function canManageSettings(role: string): boolean {
  return role === "owner" || role === "admin";
}

function rowGet(row: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(row, key) ? row[key] : undefined;
}

export function orgItem(row: Record<string, unknown>): Record<string, unknown> {
  const item: Record<string, unknown> = {
    id: row.id,
    name: row.name,
    slug: row.slug,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
  const role = rowGet(row, "role");
  if (role !== undefined && role !== null) {
    item.role = role;
  }
  return item;
}

export function memberItem(row: Record<string, unknown>): {
  user_id: unknown;
  name: unknown;
  image: unknown;
  color: unknown;
  role: unknown;
  created_at: string;
} {
  return {
    user_id: row.user_id,
    name: row.name,
    image: rowGet(row, "image") ?? null,
    color: rowGet(row, "color") ?? null,
    role: row.role,
    created_at: iso(row.created_at),
  };
}
