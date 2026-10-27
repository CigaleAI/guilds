import { listOrgsForUser } from "../db/orgs.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import { getUserByEmail } from "../db/users.js";
import { listUsersInSeedOrder } from "./directory.js";

/** The db/ functions core's sign-in modes resolve a request's user and organisation through, on `db`. */
export function identityDatabase(db: Queryable) {
  return {
    listUsers: bindQuery(db, listUsersInSeedOrder),
    listOrgsForUser: bindQuery(db, listOrgsForUser),
    getUserByEmail: bindQuery(db, getUserByEmail),
  };
}

export type IdentityDatabase = ReturnType<typeof identityDatabase>;
