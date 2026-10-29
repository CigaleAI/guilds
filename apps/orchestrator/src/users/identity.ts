import { listOrgsForUser, type OrgMembershipRow } from "../db/orgs.js";
import type { Queryable } from "../db/pg.js";
import { getUserByEmail, type UserRow } from "../db/users.js";
import { resolveOrg } from "../organisations/index.js";
import { listUsersInSeedOrder } from "./directory.js";
import { resolveUser, UserIdentityError } from "./index.js";

/** The user `token` names, or the only user when it names none; a `UserIdentityError` otherwise. */
export async function resolveTokenUser(db: Queryable, token: string | null): Promise<UserRow> {
  return resolveUser(await listUsersInSeedOrder(db), token);
}

/** The user an authenticating proxy vouched for by `email`; a 401 `UserIdentityError` when none has it. */
export async function resolveEmailUser(db: Queryable, email: string): Promise<UserRow> {
  const user = await getUserByEmail(db, email);
  if (!user) {
    throw new UserIdentityError(401, "user not found");
  }
  return user;
}

/** The membership of `userId` that `token` names, or its only one when it names none; an `OrgIdentityError` otherwise. */
export async function resolveTokenOrg(
  db: Queryable,
  userId: string,
  token: string | null,
): Promise<OrgMembershipRow> {
  return resolveOrg(await listOrgsForUser(db, userId), token);
}
