import { LastOrgOwner } from "../db/errors.js";
import type { OrgCreatedHook } from "../db/orgs.js";
import { isUniqueViolation, type Queryable } from "../db/pg.js";
import { deleteUser, getUser, insertUser, listUsers, setUserEmail } from "../db/users.js";
import { assertNotSoleGuildAdmin } from "../guilds/operators.js";
import { newId } from "../lib/ids.js";
import { SEED_USER_IDS, userItem, validateUserEmail, validateUserName } from "./index.js";

/** A change to the user directory refused, with the HTTP status it answers with. */
export class UserError extends Error {
  status: 400 | 404 | 409;

  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "UserError";
    this.status = status;
  }
}

/** A user as the directory receives it, before validation: a name, and an email or null. */
export type UserDraft = { name: string; email: unknown };

export type UserItem = ReturnType<typeof userItem>;

/** The 409 for a user insert or update that broke a unique index; any other error as it is. */
function userConflict(error: unknown): unknown {
  if (!isUniqueViolation(error)) {
    return error;
  }
  const index =
    typeof error === "object" && error !== null && "constraint" in error ? error.constraint : null;
  return new UserError(
    409,
    index === "users_email_lower_unique"
      ? "email already belongs to a user"
      : "user name already exists",
  );
}

export async function listDirectoryUsers(db: Queryable): Promise<UserItem[]> {
  return (await listUsers(db)).map((row) => userItem(row));
}

/** Creates a user and their personal organisation; `orgCreated` runs for that organisation. */
export async function createUser(
  db: Queryable,
  draft: UserDraft,
  orgCreated?: OrgCreatedHook,
): Promise<UserItem> {
  const name = validateUserName(draft.name);
  const email = validateUserEmail(draft.email);
  const user = { userId: newId("user"), name, image: null, email };
  try {
    return userItem(await insertUser(db, user, new Date(), orgCreated));
  } catch (error) {
    throw userConflict(error);
  }
}

/** Sets the email a user is identified by behind an authenticating proxy; null clears it. */
export async function changeUserEmail(
  db: Queryable,
  userId: string,
  email: unknown,
): Promise<UserItem> {
  const address = validateUserEmail(email);
  let row;
  try {
    row = await setUserEmail(db, userId, address, new Date());
  } catch (error) {
    throw userConflict(error);
  }
  if (row === null) {
    throw new UserError(404, "user not found");
  }
  return userItem(row);
}

/**
 * Deletes a user. The seed user stays, and so does a user who is the only admin of a guild or the
 * only owner of an organisation that keeps other members or guilds.
 */
export async function removeUser(db: Queryable, userId: string): Promise<void> {
  if ((await getUser(db, userId)) === null) {
    throw new UserError(404, "user not found");
  }
  if (SEED_USER_IDS.has(userId)) {
    throw new UserError(400, "seed user cannot be deleted");
  }
  await assertNotSoleGuildAdmin(db, userId, null);
  let deleted;
  try {
    deleted = await deleteUser(db, userId);
  } catch (error) {
    throw error instanceof LastOrgOwner ? new UserError(409, error.message) : error;
  }
  if (deleted === null) {
    throw new UserError(404, "user not found");
  }
}
