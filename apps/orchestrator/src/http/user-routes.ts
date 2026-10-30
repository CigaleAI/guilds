import { Type } from "@sinclair/typebox";
import {
  changeUserEmail,
  createUser,
  listDirectoryUsers,
  removeUser,
  UserDraftSchema,
  UserEmailSchema,
} from "../users/directory.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { HttpError } from "./errors.js";
import { currentUser, type IdentityRequest } from "./identity.js";
import { isInstanceAdmin } from "./instance-admin.js";

/** The path of one user of the directory. */
const UserParams = Type.Object({ user_id: Type.String() });

/** The user directory: every user of the box, created and removed by whoever may manage it. */
export async function registerUserRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const { db } = deps;

  /**
   * On a compat-cookie box whoever reaches the directory may act as any user, so it is open; behind
   * an authenticating proxy it is the instance administrator's; a mode an extension adds has none.
   * Each route runs it as its `preValidation` hook, so whoever is refused gets the same 404 whatever
   * they send.
   */
  async function requireUserDirectory(request: IdentityRequest): Promise<void> {
    const mode = deps.config?.authMode ?? "compat-cookie";
    if (mode === "compat-cookie") {
      return;
    }
    if (mode === "trusted-header" && !deps.identity) {
      const user = await currentUser(db, request, deps);
      if (await isInstanceAdmin(deps, user.id)) {
        return;
      }
    }
    throw new HttpError(404, "Not Found");
  }

  const preValidation = requireUserDirectory;

  app.get("/api/users", { preValidation }, async () => listDirectoryUsers(db));

  app.post(
    "/api/users",
    { preValidation, schema: { body: UserDraftSchema } },
    async (request, reply) =>
      reply.code(201).send(await createUser(db, request.body, deps.orgCreated)),
  );

  app.patch(
    "/api/users/:user_id",
    { preValidation, schema: { params: UserParams, body: UserEmailSchema } },
    async (request) => changeUserEmail(db, request.params.user_id, request.body.email),
  );

  app.delete(
    "/api/users/:user_id",
    { preValidation, schema: { params: UserParams } },
    async (request, reply) => {
      await removeUser(db, request.params.user_id);
      return reply.code(204).send();
    },
  );
}
