import type { ReachedNote } from "../../api/types";

/** Where a note opens: a guild's Files view, or an agent's Notes view when `agentId` is set. */
export type NoteLink = { guildId: string; agentId?: string; path: string };

const linkByLevel: Record<
  ReachedNote["level"],
  (note: ReachedNote, listedGuildId: string) => NoteLink | null
> = {
  org: (note, listedGuildId) => ({ guildId: listedGuildId, path: note.display_path }),
  guild: (note) => ({ guildId: note.owner_id, path: note.display_path }),
  agent: (note) =>
    note.guild_id
      ? { guildId: note.guild_id, agentId: note.owner_id, path: note.display_path }
      : null,
};

/**
 * The view that opens a note: an organisation note opens in the listed guild's Files view, whose
 * tree also shows the organisation's notes. Null when an agent note carries no guild.
 */
export function noteLink(note: ReachedNote, listedGuildId: string): NoteLink | null {
  return linkByLevel[note.level](note, listedGuildId);
}

const placementByLevel: Record<ReachedNote["level"], (note: ReachedNote) => string> = {
  org: () => "Organisation",
  guild: (note) => `Guild · ${note.owner_name}`,
  agent: (note) => `Agent · ${note.owner_name}`,
};

/** Where a note is placed, in words: the organisation, or the guild or agent that owns it. */
export function notePlacement(note: ReachedNote): string {
  return placementByLevel[note.level](note);
}
