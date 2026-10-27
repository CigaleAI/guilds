import { getGuild, type GuildRow } from "../db/guilds.js";
import { getMembership } from "../db/orgs.js";
import type { Queryable } from "../db/pg.js";
import { GuildError } from "./errors.js";
import { canSeeGuild, guildRole } from "./validation.js";

/** A guild the user sees: one of their organisation's, and private only to its operators. Any other is a 404. */
export async function requireVisibleGuild(
  db: Queryable,
  guildId: string,
  userId: string,
): Promise<GuildRow> {
  const row = await getGuild(db, guildId);
  if (row === null) {
    throw new GuildError(404, "guild not found");
  }
  const membership = await getMembership(db, row.org_id, userId);
  if (membership === null || !canSeeGuild(row, userId)) {
    throw new GuildError(404, "guild not found");
  }
  return row;
}

/** A guild the user sees and administers; one they see but do not administer is a 403. */
export async function requireAdministeredGuild(
  db: Queryable,
  guildId: string,
  userId: string,
): Promise<GuildRow> {
  const row = await requireVisibleGuild(db, guildId, userId);
  if (guildRole(row, userId) !== "admin") {
    throw new GuildError(403, "only a guild admin can do this");
  }
  return row;
}
