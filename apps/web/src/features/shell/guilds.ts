import type { Guild } from "../../api/types";

/** Two letters for a guild's rail tile: the first letter of its first two words. */
export function guildInitials(name: string): string {
  const words = name.split(/[\s_-]+/).filter(Boolean);
  const [first, second] = words;
  return (first && second ? `${first[0]}${second[0]}` : name.slice(0, 2)).toUpperCase();
}

/** Guilds the sidebar lists: everything not archived, in the server's order. */
export function listedGuilds(guilds: readonly Guild[] | undefined): Guild[] {
  return (guilds ?? []).filter((guild) => !guild.archived_at);
}
