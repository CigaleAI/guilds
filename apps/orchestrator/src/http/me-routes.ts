import { ProfileChangeSchema, changeOwnProfile, type UserItem } from "../users/directory.js";
import { userItem } from "../users/index.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { currentUser } from "./identity.js";
import { isInstanceAdmin } from "./instance-admin.js";
import type { UserRow } from "../db/users.js";

/** The request's own user, and whether they administer the instance. */
type Me = UserItem & { platform_admin: boolean };

/** How this server identifies a request, and the request's own user. */
export async function registerMeRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const { db } = deps;

  async function me(user: UserRow): Promise<Me> {
    return {
      ...userItem(user),
      platform_admin: await isInstanceAdmin(deps, user.id),
    };
  }

  /** Read before anyone is identified: the mode, and what an identity provider's sign-in page needs. */
  app.get("/api/auth/config", async () => ({
    mode: deps.config?.authMode ?? "compat-cookie",
    ...(deps.identity?.describe?.() ?? {}),
  }));

  app.get("/api/auth/me", async (request, reply) => {
    const user = await currentUser(db, request, deps);
    deps.identity?.onSend?.(request, reply);
    return me(user);
  });

  app.patch("/api/auth/me", { schema: { body: ProfileChangeSchema } }, async (request) => {
    const user = await currentUser(db, request, deps);
    return me(await changeOwnProfile(db, user.id, request.body));
  });

}
