import type { FastifyInstance } from "fastify";
import { changeUserEmail, createUser, listDirectoryUsers, removeUser } from "../users/directory.js";
import type { AppDeps } from "./deps.js";
import { HttpError, missingBodyFields } from "./errors.js";
import { currentUser, type IdentityRequest } from "./identity.js";
import { isInstanceAdmin } from "./instance-admin.js";
import { bodyOf, param } from "./request.js";

/** The user directory: every user of the box, created and removed by whoever may manage it. */
export async function registerUserRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;

  /**
   * On a compat-cookie box whoever reaches the directory may act as any user, so it is open; behind
   * an authenticating proxy it is the instance administrator's; a mode an extension adds has none.
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

  app.get("/api/users", async (request) => {
    await requireUserDirectory(request);
    return listDirectoryUsers(db);
  });

  app.post("/api/users", async (request, reply) => {
    await requireUserDirectory(request);
    const missing = missingBodyFields(request.body, ["name"]);
    if (missing) {
      throw missing;
    }
    const body = bodyOf(request);
    const user = await createUser(
      db,
      { name: String(body.name ?? ""), email: body.email ?? null },
      deps.orgCreated,
    );
    return reply.code(201).send(user);
  });

  app.patch("/api/users/:user_id", async (request) => {
    await requireUserDirectory(request);
    const body = bodyOf(request);
    if (!("email" in body)) {
      throw new HttpError(422, "email is required");
    }
    return changeUserEmail(db, param(request, "user_id"), body.email);
  });

  app.delete("/api/users/:user_id", async (request, reply) => {
    await requireUserDirectory(request);
    await removeUser(db, param(request, "user_id"));
    return reply.code(204).send();
  });
}
