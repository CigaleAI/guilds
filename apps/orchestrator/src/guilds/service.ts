import { listAgents } from "../db/agents.js";
import { userActor } from "../db/config-changes.js";
import {
  getGuild,
  listGuildsForUser,
  updateGuild,
  type GuildPatch,
  type GuildRow,
} from "../db/guilds.js";
import { isUniqueViolation, type Queryable } from "../db/pg.js";
import type { GenerationLoop } from "../generation/index.js";
import { newId } from "../lib/ids.js";
import type { NotesStore } from "../notes/store.js";
import { assertCanCreateGuild, orgCounts, type OrgPolicy } from "../policy/index.js";
import type { Schedules } from "../schedules/service.js";
import { requireAdministeredGuild } from "./access.js";
import { GuildError } from "./errors.js";
import { guildDatabase, persistGuild } from "./persist.js";
import {
  validateAbout,
  validateGitAuthorEmail,
  validateGuildDescription,
  validateGuildName,
  validateMaxAgents,
  validateRoutinesEnabled,
  validateVisibility,
} from "./validation.js";

/** What guilds are created, changed and deleted through, built once from the app's services. */
export type GuildServices = {
  db: Queryable;
  notes: NotesStore;
  policy: OrgPolicy;
  schedules: Schedules;
  /** The generation loop that runs the guild's agents; absent on a box without one. */
  generation: Pick<GenerationLoop, "deleting_guild" | "agent_is_busy" | "delete_guild"> | null;
};

/** A new guild as it is asked for, before validation. */
export type GuildDraft = { name: string; about: string; description: string; visibility: unknown };

/** A guild's settings as a patch asks for them, before validation; an absent field stays as it is. */
export type GuildSettingsPatch = {
  name?: string;
  about?: string;
  description?: string;
  maxAgents?: unknown;
  gitAuthorEmail?: unknown;
  visibility?: unknown;
  routinesEnabled?: unknown;
};

/** The organisation a guild is created in. */
export type GuildOrg = { id: string; slug: string };

/** The user acting on a guild: who it records as the creator or the author of a change. */
export type GuildActor = { id: string; name: string };

function nameConflict(error: unknown): unknown {
  return isUniqueViolation(error) ? new GuildError(409, "guild name already exists") : error;
}

export async function listUserGuilds(
  db: Queryable,
  orgId: string,
  userId: string,
): Promise<GuildRow[]> {
  return listGuildsForUser(db, orgId, userId);
}

/** Creates a guild in the organisation within its policy's guild cap, with the creator as its admin. */
export async function createGuild(
  services: GuildServices,
  org: GuildOrg,
  creator: GuildActor,
  draft: GuildDraft,
): Promise<GuildRow> {
  const { db, notes, policy } = services;
  const name = validateGuildName(draft.name);
  const about = validateAbout(draft.about);
  const description = validateGuildDescription(draft.description);
  const visibility = validateVisibility(draft.visibility);
  await assertCanCreateGuild(policy, orgCounts(db), org.id);
  const guildId = newId("guild");
  const guild = {
    guildId,
    name,
    now: new Date(),
    orgId: org.id,
    orgSlug: org.slug,
    about,
    description,
    visibility,
    creatorUserId: creator.id,
  };
  try {
    await persistGuild(guildDatabase(db), notes, guild);
  } catch (error) {
    throw nameConflict(error);
  }
  const created = await getGuild(db, guildId);
  if (created === null) {
    throw new Error("guild not found after create");
  }
  return created;
}

/** Refuses a rename while the guild is being deleted or one of its agents is generating. */
async function assertRenameable(services: GuildServices, guildId: string): Promise<void> {
  const { generation } = services;
  if (generation === null) {
    return;
  }
  if (generation.deleting_guild(guildId)) {
    throw new GuildError(409, "guild is being deleted");
  }
  const members = await listAgents(services.db, guildId);
  if (members.some((row) => generation.agent_is_busy(row.id))) {
    throw new GuildError(409, "a member agent is already generating");
  }
}

/** The database patch a settings patch asks for, each field validated; an absent field is null. */
function validateGuildSettings(patch: GuildSettingsPatch): GuildPatch {
  const optional = <V, T>(value: V | undefined, validate: (raw: V) => T): T | null =>
    value === undefined ? null : validate(value);
  const routinesEnabled = optional(patch.routinesEnabled, validateRoutinesEnabled);
  return {
    name: optional(patch.name, validateGuildName),
    about: optional(patch.about, validateAbout),
    description: optional(patch.description, validateGuildDescription),
    maxAgents: optional(patch.maxAgents, validateMaxAgents),
    gitAuthorEmail: optional(patch.gitAuthorEmail, validateGitAuthorEmail),
    visibility: optional(patch.visibility, validateVisibility),
    ...(routinesEnabled === null ? {} : { routinesEnabled }),
  };
}

/** Moves a renamed guild's notes folder, putting its old name back when the folder cannot move. */
async function moveGuildNotes(
  services: GuildServices,
  guild: GuildRow,
  name: string,
  actor: GuildActor,
): Promise<void> {
  try {
    await services.notes.renameGuild(guild.org_slug, guild.name, name);
  } catch (error) {
    await updateGuild(services.db, guild.id, new Date(), { name: guild.name }, userActor(actor));
    throw error;
  }
}

/**
 * Changes a guild's settings. Only an admin changes its visibility; a rename moves its notes folder
 * and waits while it is being deleted or an agent of it is generating; switching routines on
 * releases its held schedules.
 */
export async function updateGuildSettings(
  services: GuildServices,
  guild: GuildRow,
  actor: GuildActor,
  patch: GuildSettingsPatch,
): Promise<GuildRow> {
  const { db, schedules } = services;
  const changes = validateGuildSettings(patch);
  const { name, visibility, routinesEnabled } = changes;
  if (visibility && visibility !== guild.visibility) {
    await requireAdministeredGuild(db, guild.id, actor.id);
  }
  const renamed = typeof name === "string" && name !== guild.name ? name : null;
  if (renamed !== null) {
    await assertRenameable(services, guild.id);
  }
  let row;
  try {
    row = await updateGuild(db, guild.id, new Date(), changes, userActor(actor));
  } catch (error) {
    throw nameConflict(error);
  }
  if (row === null) {
    throw new GuildError(404, "guild not found");
  }
  if (renamed !== null) {
    await moveGuildNotes(services, guild, renamed, actor);
  }
  if (routinesEnabled === true && guild.routines_enabled === false) {
    await schedules.releaseGuild(guild.id);
  }
  return row;
}

/** Deletes a guild with its agents, runs and notes, through the generation loop that runs them. */
export async function deleteGuild(services: GuildServices, guild: GuildRow): Promise<void> {
  if (services.generation === null) {
    throw new GuildError(503, "generation is unavailable");
  }
  await services.generation.delete_guild(guild.id);
}
