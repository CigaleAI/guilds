import type { FastifyInstance } from "fastify";
import { requireVisibleGuild } from "../guilds/access.js";
import { Issues, issuesDatabase } from "../issues/index.js";
import type { AppDeps } from "./deps.js";
import { HttpError } from "./errors.js";
import { currentUser, identityDatabase } from "./identity.js";
import { publishGroup } from "./publish.js";
import { bodyOf, param, queryOf } from "./request.js";

function resolverOf(user: Record<string, unknown>): string {
  return typeof user.name === "string" ? user.name : "user";
}

/** A guild's issues: listed, resolved together, and set open or resolved one at a time. */
export async function registerIssueRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const identityDb = identityDatabase(db);
  const issues = new Issues(issuesDatabase(db));

  app.get("/api/guilds/:guild_id/issues", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), String(user.id));
    return issues.listForGuild(guild.id, queryOf(request).status);
  });

  app.post("/api/guilds/:guild_id/issues/resolve", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), String(user.id));
    const resolved = await issues.resolveOpen(guild.id, resolverOf(user));
    if (resolved > 0) {
      await publishGroup(deps, guild.id, "guild.issues.changed", { action: "resolved" });
    }
    return { resolved };
  });

  app.patch("/api/guilds/:guild_id/issues/:issue_id", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), String(user.id));
    const status = bodyOf(request).status;
    if (status === undefined) {
      throw new HttpError(422, "status is required");
    }
    const row = await issues.setStatus(
      guild.id,
      param(request, "issue_id"),
      status,
      resolverOf(user),
    );
    await publishGroup(deps, guild.id, "guild.issues.changed", {
      action: String(status),
      issue_id: row.id,
    });
    return row;
  });
}
