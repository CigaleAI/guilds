import { listOrgsForUser } from "../db/orgs.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import { getUserByEmail, listUsers } from "../db/users.js";

/** The db/ functions core's sign-in modes resolve a request's user and organisation through, on `db`. */
export function identityDatabase(db: Queryable) {
  return {
    listUsers: bindQuery(db, listUsers),
    listOrgsForUser: bindQuery(db, listOrgsForUser),
    getUserByEmail: bindQuery(db, getUserByEmail),
  };
}

export type IdentityDatabase = ReturnType<typeof identityDatabase>;
