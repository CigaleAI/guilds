import { ownsSeedOrg } from "../organisations/service.js";
import type { AppDeps } from "./deps.js";
import { HttpError } from "./errors.js";
import { currentUser, type IdentityRequest } from "./identity.js";
import type { UserRow } from "../db/users.js";

/** Decides whether a user may administer the instance, in place of core's rule. */
export type InstanceAdmin = (userId: string) => Promise<boolean>;

/**
 * Whether a user may administer the instance: its connector catalog, its instance-level access,
 * and new organisations. Core's rule is an owner of the seed organisation.
 */
export async function isInstanceAdmin(
  deps: Pick<AppDeps, "db" | "instanceAdmin">,
  userId: string,
): Promise<boolean> {
  if (deps.instanceAdmin) {
    return deps.instanceAdmin(userId);
  }
  return ownsSeedOrg(deps.db, userId);
}

/** The request's user when they administer the instance; otherwise the route does not exist (404). */
export async function requireInstanceAdmin(
  deps: Pick<AppDeps, "db" | "instanceAdmin" | "config" | "identity">,
  request: IdentityRequest,
): Promise<UserRow> {
  const user = await currentUser(deps.db, request, deps);
  if (!(await isInstanceAdmin(deps, user.id))) {
    throw new HttpError(404, "Not Found");
  }
  return user;
}

/**
 * A route's `preValidation` hook that refuses whoever is not the instance admin, as
 * `requireInstanceAdmin` does, before the route's schema checks the request: a refused caller
 * gets the same 404 whatever they send.
 */
export function instanceAdminOnly(
  deps: Pick<AppDeps, "db" | "instanceAdmin" | "config" | "identity">,
): (request: IdentityRequest) => Promise<void> {
  return async (request) => {
    await requireInstanceAdmin(deps, request);
  };
}
