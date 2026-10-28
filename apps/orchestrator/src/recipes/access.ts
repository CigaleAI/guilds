import { isAccessMode, resolveAccess, type AccessSubject, type AccessTarget, type AgentAccessMode, type ArtifactActor } from "../artifacts/types.js";
import type { AccessMode } from "../db/schema/index.js";
import type { ArtifactStore } from "../artifacts/store.js";
import type { AccessEntry, AccessGrant } from "../artifacts/access.js";
import type { RecipeCollection, RecipeNote } from "./schema.js";
import { grantAccess, listAccess } from "../artifacts/access-lists.js";

/**
 * What a recipe carries of a table's or a note's access list: the mode every
 * agent of the guild gets, and the roles whose agents write on top of it.
 * Rows naming other guilds or their agents are not portable and stay out.
 */
export type RecipeAccess = { guild?: AccessMode; writers: string[] };

/** The captured guild and its member agents, by agent id, with the role each one becomes. */
export type CapturedGuild = { guildId: string; members: Map<string, string> };

const MODE_RANK: Record<AccessMode, number> = { read: 1, write: 2 };

function modeRank(mode: AccessMode | null): number {
  return mode === null ? 0 : MODE_RANK[mode];
}

function rowOf(entries: AccessEntry[], type: AccessSubject, id?: string): AgentAccessMode | null {
  return (
    entries.find((entry) => entry.type === type && (id === undefined || entry.id === id))?.mode ??
    null
  );
}

function asMode(value: AgentAccessMode | null): AccessMode | null {
  return isAccessMode(value) ? value : null;
}

function betterMode(first: AccessMode | null, second: AccessMode | null): AccessMode | null {
  return modeRank(first) >= modeRank(second) ? first : second;
}

/** A guild's mode on an item: the better of its own row and its organisation's. */
export function guildModeOn(entries: AccessEntry[], guildId: string): AccessMode | null {
  return betterMode(asMode(rowOf(entries, "guild", guildId)), asMode(rowOf(entries, "org")));
}

/** An agent's mode on an item: its own row when it has one, otherwise its guild's mode. */
function agentModeOn(
  entries: AccessEntry[],
  agentId: string,
  guildMode: AccessMode | null,
): AccessMode | null {
  return resolveAccess(guildMode, rowOf(entries, "agent", agentId));
}

/**
 * The guild's mode on an item, and the roles of the members whose own row is
 * `write` where the guild's mode is not.
 */
function guildAccessOn(
  entries: AccessEntry[],
  guild: CapturedGuild,
): { guild: AccessMode | null; writers: string[] } {
  const guildMode = guildModeOn(entries, guild.guildId);
  if (guildMode === "write") {
    return { guild: guildMode, writers: [] };
  }
  const writers = [...guild.members]
    .filter(([agentId]) => rowOf(entries, "agent", agentId) === "write")
    .map(([, role]) => role);
  return { guild: guildMode, writers };
}

function reachesAnyMember(entries: AccessEntry[], guild: CapturedGuild): boolean {
  return [...guild.members.keys()].some((agentId) =>
    isAccessMode(rowOf(entries, "agent", agentId)),
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
 * What a note's access list gives the captured guild, as a recipe carries it.
 * A guild note keeps the guild's `write`; the owner of an agent note reaches
 * it without a row, so it is never one of its writers.
 */
export function capturedNoteAccess(
  entries: AccessEntry[],
  note: Pick<RecipeNote, "level" | "role">,
  guild: CapturedGuild,
): Pick<RecipeNote, "guild" | "writers"> {
  if (note.level === "guild") {
    return { guild: "write", writers: [] };
  }
  const access = guildAccessOn(entries, guild);
  const writers = access.writers.filter((role) => role !== note.role);
  return access.guild === null ? { writers } : { guild: access.guild, writers };
}

/**
 * The rows that bring the new guild up to the recipe's `guild` mode and each
 * writer agent up to `write`. A subject that already holds as much gets no
 * row, so an existing row is never lowered.
 */
export function accessRaises(
  entries: AccessEntry[],
  access: RecipeAccess,
  subjects: { guildId: string; writerIds: string[] },
): AccessGrant[] {
  const held = guildModeOn(entries, subjects.guildId);
  const wanted = access.guild ?? null;
  const raisesGuild = wanted !== null && modeRank(wanted) > modeRank(held);
  const guildMode = betterMode(held, wanted);
  const writers: AccessGrant[] = subjects.writerIds
    .filter((agentId) => agentModeOn(entries, agentId, guildMode) !== "write")
    .map((agentId) => ({ type: "agent", id: agentId, mode: "write" }));
  return raisesGuild
    ? [{ type: "guild", id: subjects.guildId, mode: wanted }, ...writers]
    : writers;
}

/** The agents apply created for `roles`, skipping a role it did not create. */
export function agentsOfRoles(roles: string[], roleToAgent: Map<string, string>): string[] {
  return roles.flatMap((role) => roleToAgent.get(role) ?? []);
}

/** Raises an item's access list to what a recipe gives the new guild and its agents. */
export async function raiseRecipeAccess(
  deps: { artifacts: ArtifactStore; actor: ArtifactActor },
  target: AccessTarget,
  wanted: { access: RecipeAccess; guildId: string; writerIds: string[] },
): Promise<void> {
  const entries = await listAccess(deps.artifacts, deps.actor, target);
  for (const grant of accessRaises(entries, wanted.access, wanted)) {
    await grantAccess(deps.artifacts, deps.actor, target, { ...grant, mode: grant.mode });
  }
}
