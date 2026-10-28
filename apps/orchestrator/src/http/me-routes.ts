import type { FastifyInstance } from "fastify";
import { changeOwnProfile } from "../users/directory.js";
import { userItem } from "../users/index.js";
import type { AppDeps } from "./deps.js";
import { currentUser } from "./identity.js";
import { identityDatabase } from "../users/identity.js";
import { isInstanceAdmin } from "./instance-admin.js";
import { bodyOf } from "./request.js";
import type { UserRow } from "../db/users.js";

/** How this server identifies a request, and the request's own user. */
export async function registerMeRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const identityDb = identityDatabase(db);

  async function me(user: UserRow): Promise<Record<string, unknown>> {
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
    const user = await currentUser(identityDb, request, deps);
    deps.identity?.onSend?.(request, reply);
    return me(user);
  });

  app.patch("/api/auth/me", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const body = bodyOf(request);
    const change = {
      ...("name" in body ? { name: body.name } : {}),
      ...("timezone" in body ? { timezone: body.timezone } : {}),
      ...("color" in body ? { color: body.color } : {}),
    };
    return me(await changeOwnProfile(db, user.id, change));
  });

}
