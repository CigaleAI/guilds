import { soleAdminGuilds } from "../db/guilds.js";
import type { Queryable } from "../db/pg.js";
import { GuildError } from "./errors.js";

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
    throw new GuildError(409, `user is the only admin of ${names}; name another admin first`);
  }
}
