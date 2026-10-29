import { Type } from "@sinclair/typebox";
import { requireVisibleGuild } from "../guilds/access.js";
import { guildIssues } from "../issues/index.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { currentUser } from "./identity.js";
import { GuildParams } from "./params.js";
import { publishGroup } from "./publish.js";
import type { UserRow } from "../db/users.js";

/** Which of a guild's issues to list: `open`, `resolved`, or every one when left out or `all`. */
const IssueListQuery = Type.Object({ status: Type.Optional(Type.String()) });

/** The path of one issue of a guild. */
const IssueParams = Type.Object({ guild_id: Type.String(), issue_id: Type.String() });

/** The status an issue is set to. */
const IssueStatusBody = Type.Object({ status: Type.String() });

function resolverOf(user: UserRow): string {
  return typeof user.name === "string" ? user.name : "user";
}

/** A guild's issues: listed, resolved together, and set open or resolved one at a time. */
export async function registerIssueRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const issues = guildIssues(db);

  app.get(
    "/api/guilds/:guild_id/issues",
    { schema: { params: GuildParams, querystring: IssueListQuery } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const guild = await requireVisibleGuild(db, request.params.guild_id, user.id);
      return issues.listForGuild(guild.id, request.query.status);
    },
  );

  app.post(
    "/api/guilds/:guild_id/issues/resolve",
    { schema: { params: GuildParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const guild = await requireVisibleGuild(db, request.params.guild_id, user.id);
      const resolved = await issues.resolveOpen(guild.id, resolverOf(user));
      if (resolved > 0) {
        await publishGroup(deps, guild.id, "guild.issues.changed", { action: "resolved" });
      }
      return { resolved };
    },
  );

  app.patch(
    "/api/guilds/:guild_id/issues/:issue_id",
    { schema: { params: IssueParams, body: IssueStatusBody } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const guild = await requireVisibleGuild(db, request.params.guild_id, user.id);
      const { status } = request.body;
      const issueId = request.params.issue_id;
      const row = await issues.setStatus(guild.id, issueId, status, resolverOf(user));
      await publishGroup(deps, guild.id, "guild.issues.changed", {
        action: status,
        issue_id: row.id,
      });
      return row;
    },
  );
}
