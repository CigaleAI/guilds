import { recordChangeIfAny, type ConfigChange } from "../db/config-changes.js";
import { getGuild, lockGuildText, updateGuild, type GuildPatch, type GuildRow } from "../db/guilds.js";
import { type Queryable, withTransaction } from "../db/pg.js";
import type { ChangeActor } from "../lib/change-actor.js";

export type GuildTextFields = { about: string; description: string };

/** The change-log entry for a guild's about and description going from `before` to `after`; null when neither changed. */
export function guildTextChange(
  guildId: string,
  before: GuildTextFields,
  after: GuildTextFields,
): ConfigChange | null {
  const fields = (["about", "description"] as const).filter(
    (field) => before[field] !== after[field],
  );
  if (!fields.length) {
    return null;
  }
  return {
    guildId,
    targetKind: "guild_text",
    targetId: guildId,
    operation: "update",
    summary: `Changed the ${fields.join(" and ")}`,
  };
}

/** Changes a guild's settings; a change to its about or description is logged against `actor`. Null when there is no such guild. */
export async function changeGuild(
  db: Queryable,
  guildId: string,
  patch: GuildPatch,
  actor: ChangeActor,
): Promise<GuildRow | null> {
  const updated = await withTransaction(db, async (client) => {
    const before = await lockGuildText(client, guildId);
    const after = await updateGuild(client, guildId, new Date(), patch);
    if (before && after) {
      await recordChangeIfAny(client, actor, guildTextChange(guildId, before, after));
    }
    return after;
  });
  return updated ? getGuild(db, guildId) : null;
}
