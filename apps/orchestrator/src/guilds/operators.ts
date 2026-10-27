import { soleAdminGuilds } from "../db/guilds.js";
import type { Queryable } from "../db/pg.js";

/** A change to a guild's operators refused, with the HTTP status it answers with. */
export class GuildOperatorError extends Error {
  status: 404 | 409 | 422;

  constructor(status: 404 | 409 | 422, message: string) {
    super(message);
    this.name = "GuildOperatorError";
    this.status = status;
  }
}

/**
 * Refuses while the user is the only admin of a guild, in the organisation or in any when `orgId`
 * is null: leaving would strand the guild, so it waits until another admin is named.
 */
export async function assertNotSoleGuildAdmin(
  db: Queryable,
  userId: string,
  orgId: string | null,
): Promise<void> {
  const guilds = await soleAdminGuilds(db, userId, orgId);
  if (guilds.length) {
    const names = guilds.map((guild) => guild.name).join(", ");
    throw new GuildOperatorError(
      409,
      `user is the only admin of ${names}; name another admin first`,
    );
  }
}
