import { LastOrgOwner } from "../db/errors.js";
import {
  deleteMember,
  getMembership,
  insertMember,
  insertOrg,
  listMembers,
  listOrgsForUser,
  updateMemberRole,
  updateOrg,
  type OrgCreatedHook,
  type OrgMembershipRow,
} from "../db/orgs.js";
import { isUniqueViolation, type Queryable } from "../db/pg.js";
import { getUser, getUserByName } from "../db/users.js";
import { assertNotSoleGuildAdmin } from "../guilds/operators.js";
import { newId } from "../lib/ids.js";
import type { NotesStore } from "../notes/store.js";
import {
  canManageMembers,
  canManageOwners,
  canManageSettings,
  memberItem,
  orgItem,
  SEED_ORG_ID,
  validateOrgName,
  validateRole,
  validateSlug,
  type OrgRole,
} from "./index.js";

/** A change to an organisation or its members refused, with the HTTP status it answers with. */
export class OrgError extends Error {
  status: 404 | 409;

  constructor(status: 404 | 409, message: string) {
    super(message);
    this.name = "OrgError";
    this.status = status;
  }
}

/** A new organisation as it is asked for, before validation, and the user who will own it. */
export type OrgDraft = { name: string; slug: string; ownerId: string };

/** The settings an organisation patch changes; an absent field stays as it is. */
export type OrgPatch = { name?: string; slug?: string };

/** The user a member is added as: by id, or by name with an optional leading `@`. */
export type MemberRef = { userId: string } | { name: string };

type Item = Record<string, unknown>;

const NOT_FOUND = "organisation not found";

/** Runs an owner change, answering 409 when it would leave the organisation without an owner. */
async function refuseLastOrgOwner<T>(change: () => Promise<T>): Promise<T> {
  try {
    return await change();
  } catch (error) {
    throw error instanceof LastOrgOwner ? new OrgError(409, error.message) : error;
  }
}

/** Whether a member with `actorRole` may change a member whose role is, or becomes, one of `roles`. */
function mayChangeMember(actorRole: string, roles: string[]): boolean {
  return roles.includes("owner") ? canManageOwners(actorRole) : canManageMembers(actorRole);
}

/** The user's membership of the organisation; one they are not in does not exist for them (404). */
export async function requireMembership(
  db: Queryable,
  orgId: string,
  userId: string,
): Promise<OrgMembershipRow> {
  const membership = await getMembership(db, orgId, userId);
  if (membership === null) {
    throw new OrgError(404, NOT_FOUND);
  }
  return membership;
}

/** The user's membership of an organisation they manage, as an owner or admin; any other is a 404. */
export async function requireOrgManager(
  db: Queryable,
  orgId: string,
  userId: string,
): Promise<OrgMembershipRow> {
  const membership = await requireMembership(db, orgId, userId);
  if (!canManageSettings(membership.role)) {
    throw new OrgError(404, NOT_FOUND);
  }
  return membership;
}

/** Whether the user manages the organisation, as an owner or admin. */
export async function isOrgManager(db: Queryable, orgId: string, userId: string): Promise<boolean> {
  const membership = await getMembership(db, orgId, userId);
  return membership !== null && canManageSettings(membership.role);
}

/** Whether the user owns the seed organisation: core's rule for who administers the instance. */
export async function ownsSeedOrg(db: Queryable, userId: string): Promise<boolean> {
  return (await getMembership(db, SEED_ORG_ID, userId))?.role === "owner";
}

export async function listUserOrgs(db: Queryable, userId: string): Promise<Item[]> {
  return (await listOrgsForUser(db, userId)).map((row) => orgItem(row));
}

/** Creates an organisation with its owner and default machine; `orgCreated` runs for it. */
export async function createOrg(
  db: Queryable,
  draft: OrgDraft,
  orgCreated?: OrgCreatedHook,
): Promise<Item> {
  const name = validateOrgName(draft.name);
  const slug = validateSlug(draft.slug);
  try {
    const row = await insertOrg(
      db,
      { orgId: newId("org"), name, slug, userId: draft.ownerId },
      new Date(),
      orgCreated,
    );
    return { ...orgItem(row), role: "owner" };
  } catch (error) {
    throw isUniqueViolation(error) ? new OrgError(409, "organisation slug already exists") : error;
  }
}

/**
 * Renames an organisation or changes its slug, for an owner or admin; a new slug moves the
 * organisation's notes folder with it.
 */
export async function updateOrgSettings(
  db: Queryable,
  notes: NotesStore,
  membership: OrgMembershipRow,
  patch: OrgPatch,
): Promise<Item> {
  if (!canManageSettings(membership.role)) {
    throw new OrgError(404, NOT_FOUND);
  }
  const name = patch.name === undefined ? null : validateOrgName(patch.name);
  const slug = patch.slug === undefined ? null : validateSlug(patch.slug);
  let row;
  try {
    row = await updateOrg(db, membership.id, new Date(), { name, slug });
  } catch (error) {
    throw isUniqueViolation(error) ? new OrgError(409, "organisation slug already exists") : error;
  }
  if (row === null) {
    throw new OrgError(404, NOT_FOUND);
  }
  if (slug && slug !== membership.slug) {
    await notes.renameOrg(membership.slug, slug);
  }
  return { ...orgItem(row), role: membership.role };
}

export async function listOrgMembers(db: Queryable, membership: OrgMembershipRow): Promise<Item[]> {
  return (await listMembers(db, membership.id)).map((row) => memberItem(row));
}

async function memberOf(db: Queryable, orgId: string, userId: string): Promise<Item> {
  const rows = await listMembers(db, orgId);
  return memberItem(rows.find((row) => row.user_id === userId) ?? {});
}

/** Adds a user to the organisation with `role`; only an owner adds an owner, and an admin anyone else. */
export async function addOrgMember(
  db: Queryable,
  membership: OrgMembershipRow,
  ref: MemberRef,
  role: string,
): Promise<Item> {
  const granted: OrgRole = validateRole(role);
  if (!mayChangeMember(membership.role, [granted])) {
    throw new OrgError(404, NOT_FOUND);
  }
  const target =
    "name" in ref
      ? await getUserByName(db, ref.name.trim().replace(/^@/, "").toLowerCase())
      : await getUser(db, ref.userId);
  if (target === null) {
    throw new OrgError(404, "user not found");
  }
  try {
    await insertMember(db, membership.id, target.id, granted, new Date());
  } catch (error) {
    throw isUniqueViolation(error) ? new OrgError(409, "member already exists") : error;
  }
  return memberOf(db, membership.id, target.id);
}

/** Changes a member's role; only an owner changes an owner's or grants ownership, and the last owner stays. */
export async function changeMemberRole(
  db: Queryable,
  membership: OrgMembershipRow,
  userId: string,
  role: string,
): Promise<Item> {
  const granted = validateRole(role);
  const existing = await getMembership(db, membership.id, userId);
  if (existing === null) {
    throw new OrgError(404, "member not found");
  }
  if (!mayChangeMember(membership.role, [existing.role, granted])) {
    throw new OrgError(404, NOT_FOUND);
  }
  const updated = await refuseLastOrgOwner(() =>
    updateMemberRole(db, membership.id, userId, granted),
  );
  if (updated === null) {
    throw new OrgError(404, "member not found");
  }
  return memberOf(db, membership.id, userId);
}

/**
 * Removes a member: a member may leave, and an owner or admin may remove others as they may change
 * them. The last owner and a guild's only admin stay.
 */
export async function removeOrgMember(
  db: Queryable,
  membership: OrgMembershipRow,
  userId: string,
  actorId: string,
): Promise<void> {
  const existing = await getMembership(db, membership.id, userId);
  if (existing === null) {
    throw new OrgError(404, "member not found");
  }
  if (userId !== actorId && !mayChangeMember(membership.role, [existing.role])) {
    throw new OrgError(404, NOT_FOUND);
  }
  await assertNotSoleGuildAdmin(db, userId, membership.id);
  await refuseLastOrgOwner(() => deleteMember(db, membership.id, userId));
}
