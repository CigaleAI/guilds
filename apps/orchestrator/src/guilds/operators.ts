import { GuildNameTaken, LastGuildAdmin } from "../db/errors.js";
import { setGuildOperator, soleAdminGuilds, type GuildRow } from "../db/guilds.js";
import { getMembership } from "../db/orgs.js";
import type { Queryable } from "../db/pg.js";
import { GuildError } from "./errors.js";
import { validateGuildOperatorRole, type GuildOperatorRole } from "./validation.js";

/** The user's operator role on the guild; null when they are not one of its operators. */
export function guildRole(guild: Pick<GuildRow, "operators">, userId: string): GuildOperatorRole | null {
  return guild.operators.find((operator) => operator.user_id === userId)?.role ?? null;
}

/** An org guild is visible to every organisation member; a private one to its operators. */
export function canSeeGuild(guild: Pick<GuildRow, "visibility" | "operators">, userId: string): boolean {
  if (guild.visibility !== "private") {
    return true;
  }
  return guildRole(guild, userId) !== null;
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
    throw new GuildError(409, `user is the only admin of ${names}; name another admin first`);
  }
}

/** Writes a user's operator role on a guild, or removes them with null; the last admin stays. */
async function writeOperator(
  db: Queryable,
  guildId: string,
  userId: string,
  role: GuildOperatorRole | null,
): Promise<GuildRow> {
  let row;
  try {
    row = await setGuildOperator(db, { guild_id: guildId, user_id: userId, role }, new Date());
  } catch (error) {
    const refused = error instanceof LastGuildAdmin || error instanceof GuildNameTaken;
    throw refused ? new GuildError(409, error.message) : error;
  }
  if (row === null) {
    throw new GuildError(404, "guild not found");
  }
  return row;
}

/** Makes a member of the guild's organisation one of its operators, or changes their role. */
export async function setOperatorRole(
  db: Queryable,
  guild: GuildRow,
  userId: string,
  role: unknown,
): Promise<GuildRow> {
  const validated = validateGuildOperatorRole(role);
  if ((await getMembership(db, guild.org_id, userId)) === null) {
    throw new GuildError(422, "operators must be members of the organisation");
  }
  return writeOperator(db, guild.id, userId, validated);
}

/** Removes one of the guild's operators; the last admin stays. */
export async function removeOperator(
  db: Queryable,
  guild: GuildRow,
  userId: string,
): Promise<GuildRow> {
  if (!guild.operators.some((operator) => operator.user_id === userId)) {
    throw new GuildError(404, "operator not found");
  }
  return writeOperator(db, guild.id, userId, null);
}
