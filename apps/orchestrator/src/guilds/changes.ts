import type { ConfigChange } from "../db/config-changes.js";

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
