import type { FastifyInstance } from "fastify";
import { GuildNameTaken } from "../db/errors.js";
import { ScheduleError } from "../schedules/cron.js";
import { validateTimezone } from "../schedules/window.js";
import { UserValidationError, userItem, validateUserColor, validateUserName } from "../users/index.js";
import type { AppDeps } from "./deps.js";
import { HttpError } from "./errors.js";
import { currentUser, identityDatabase } from "./identity.js";
import { isInstanceAdmin } from "./instance-admin.js";
import { bodyOf } from "./request.js";
import { updateUserProfile } from "../db/users.js";

/** How this server identifies a request, and the request's own user. */
export async function registerMeRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const identityDb = identityDatabase(db);

  async function me(user: Record<string, unknown>): Promise<Record<string, unknown>> {
    return {
      ...userItem(user as never),
      platform_admin: await isInstanceAdmin(deps, String(user.id)),
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
    if (!("name" in body) && !("timezone" in body) && !("color" in body)) {
      throw new HttpError(422, "name, timezone, or color is required");
    }
    const profile: { name?: string; timezone?: string | null; color?: string | null } = {};
    try {
      if ("name" in body) {
        profile.name = validateUserName(String(body.name ?? "").trim());
      }
      if ("color" in body) {
        profile.color = validateUserColor(body.color);
      }
    } catch (error) {
      if (error instanceof UserValidationError) {
        throw new HttpError(422, error.message);
      }
      throw error;
    }
    if ("timezone" in body) {
      try {
        profile.timezone = body.timezone === null ? null : validateTimezone(body.timezone);
      } catch (error) {
        if (error instanceof ScheduleError) {
          throw new HttpError(422, error.message);
        }
        throw error;
      }
    }
    let row;
    try {
      row = await updateUserProfile(db, String(user.id), profile, new Date());
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") {
        throw new HttpError(409, "that name is taken");
      }
      if (error instanceof GuildNameTaken) {
        throw new HttpError(409, `${profile.name} is already an agent in a guild you operate`);
      }
      throw error;
    }
    if (row === null) {
      throw new HttpError(404, "user not found");
    }
    return me(row);
  });
}
