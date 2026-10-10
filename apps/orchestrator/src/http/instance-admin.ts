import { SEED_ORG_ID } from "../organisations/index.js";
import type { AppDeps } from "./deps.js";
import { HttpError } from "./errors.js";
import { currentUser, type IdentityRequest } from "./identity.js";

/** Decides whether a user may administer the instance, in place of core's rule. */
export type InstanceAdmin = (userId: string) => Promise<boolean>;

/**
 * Whether a user may administer the instance: its connector catalog, its instance-level access,
 * and new organisations. Core's rule is an owner of the seed organisation.
 */
export async function isInstanceAdmin(
  deps: Pick<AppDeps, "repo" | "instanceAdmin">,
  userId: string,
): Promise<boolean> {
  if (deps.instanceAdmin) {
    return deps.instanceAdmin(userId);
  }
  const membership = await deps.repo.getMembership(SEED_ORG_ID, userId);
  return membership?.role === "owner";
}

/** The request's user when they administer the instance; otherwise the route does not exist (404). */
export async function requireInstanceAdmin(
  deps: Pick<AppDeps, "repo" | "instanceAdmin" | "config" | "identity">,
  request: IdentityRequest,
): Promise<Record<string, unknown>> {
  const user = await currentUser(deps.repo, request, deps);
  if (!(await isInstanceAdmin(deps, String(user.id)))) {
    throw new HttpError(404, "Not Found");
  }
  return user;
}
