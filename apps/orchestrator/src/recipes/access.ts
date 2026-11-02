import type { AccessMode, RecipeCollection, RecipeNote } from "../db/schema/index.js";
import { effectiveAccess } from "../artifacts/access.js";
import type { AccessEntry } from "../artifacts/types.js";

/** The captured guild and its member agents, by agent id, with the role each one becomes. */
export type CapturedGuild = { guildId: string; members: Map<string, string> };

/**
 * What an item's access list gives a captured guild: the guild's mode on it, null when the guild
 * does not reach it, and the roles of the members it lets write where the guild's mode does not.
 */
type GuildAccess = Pick<RecipeCollection, "writers"> & { guild: AccessMode | null };

/** The guild's mode on an item, and the roles of the members its access list lets write. */
function guildAccessOn(entries: AccessEntry[], guild: CapturedGuild): GuildAccess {
  const guildMode = effectiveAccess(entries, { guildId: guild.guildId, agentId: null });
  if (guildMode === "write") {
    return { guild: guildMode, writers: [] };
  }
  const writers = [...guild.members]
    .filter(([agentId]) => effectiveAccess(entries, { guildId: guild.guildId, agentId }) === "write")
    .map(([, role]) => role);
  return { guild: guildMode, writers };
}

/** Whether the item's access list reaches any member agent of the guild. */
function reachesAnyMember(entries: AccessEntry[], guild: CapturedGuild): boolean {
  return [...guild.members.keys()].some(
    (agentId) => effectiveAccess(entries, { guildId: guild.guildId, agentId }) !== null,
  );
}

/**
 * What an organisation table's access list gives the captured guild, as a
 * recipe carries it. The guild's mode starts from the organisation's row; it
 * is `read` when only member agents reach the table. Null when neither the
 * guild nor any member reaches it.
 */
export function capturedTableAccess(
  entries: AccessEntry[],
  guild: CapturedGuild,
): Pick<RecipeCollection, "guild" | "writers"> | null {
  const access = guildAccessOn(entries, guild);
  if (access.guild === null && !reachesAnyMember(entries, guild)) {
    return null;
  }
  return { guild: access.guild ?? "read", writers: access.writers };
}

/**
 * What a note's access list gives the organisation and the captured guild, as a recipe carries it:
 * the organisation row's mode, the guild's mode, and the roles that write it.
 */
export function capturedNoteAccess(
  entries: AccessEntry[],
  guild: CapturedGuild,
): Pick<RecipeNote, "org" | "guild" | "writers"> {
  const access = guildAccessOn(entries, guild);
  const org = entries.find((entry) => entry.type === "org")?.mode;
  return {
    ...(org === "read" || org === "write" ? { org } : {}),
    ...(access.guild === null ? {} : { guild: access.guild }),
    writers: access.writers,
  };
}

/** The agents apply created for `roles`, skipping a role it did not create. */
export function agentsOfRoles(roles: string[], roleToAgent: Map<string, string>): string[] {
  return roles.flatMap((role) => roleToAgent.get(role) ?? []);
}
