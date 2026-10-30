import { listAgents } from "../db/agents.js";
import { recordChangeIfAny, type ConfigChange } from "../db/config-changes.js";
import {
  countGuildAgents,
  deleteGuild as deleteGuildRow,
  getGuild,
  insertGuild,
  listGuildsForUser,
  lockGuildText,
  updateGuild,
  type GuildPatch,
  type GuildRow,
  type GuildTextRow,
  type NewGuild,
} from "../db/guilds.js";
import { isUniqueViolation, type Queryable, withTransaction } from "../db/pg.js";
import { DEFAULT_GUILD_AGENTS } from "../db/schema/index.js";
import type { GenerationLoop } from "../generation/index.js";
import { userActor, type ChangeActor } from "../lib/change-actor.js";
import { newId } from "../lib/ids.js";
import type { NotesStore } from "../notes/store.js";
import { assertCanCreateGuild, type OrgPolicy } from "../policy/index.js";
import type { Schedules } from "../schedules/service.js";
import { requireAdministeredGuild } from "./access.js";
import { GuildAgentLimitError, GuildError } from "./errors.js";
import {
  validateAbout,
  validateGitAuthorEmail,
  validateGuildDescription,
  validateGuildName,
  validateGuildTextPatch,
  validateMaxAgents,
  validateRoutinesEnabled,
  validateVisibility,
  type GuildTextPatch,
} from "./validation.js";

/** What guilds are created, changed and deleted through, built once from the app's services. */
export type GuildServices = {
  db: Queryable;
  notes: NotesStore;
  policy: OrgPolicy;
  schedules: Schedules;
  /** The generation loop that runs the guild's agents; absent on a box without one. */
  generation: Pick<GenerationLoop, "isDeletingGuild" | "isAgentBusy" | "deleteGuild"> | null;
};

/** A new guild as it is asked for, before validation. */
export type GuildRequest = {
  name: string;
  about: string;
  description: string;
  visibility: string | null | undefined;
};

/** A new guild as it is written: its row, and the slug of the organisation its notes folder goes under. */
export type GuildDraft = { guild: NewGuild; orgSlug: string };

/** A guild's settings as a patch asks for them, before validation; an absent field stays as it is. */
export type GuildSettingsPatch = {
  name?: string;
  about?: string;
  description?: string;
  maxAgents?: number;
  gitAuthorEmail?: string | null;
  visibility?: string | null;
  routinesEnabled?: boolean;
};

/** The organisation a guild is created in. */
export type GuildOrg = { id: string; slug: string };

/** The user acting on a guild: who it records as the creator or the author of a change. */
export type GuildActor = { id: string; name: string };

function nameConflict(error: unknown): unknown {
  return isUniqueViolation(error) ? new GuildError(409, "guild name already exists") : error;
}

/** A guild as the API answers it. */
export function guildItem(row: GuildRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    about: row.about,
    description: row.description,
    max_agents: row.max_agents,
    git_author_email: row.git_author_email,
    database: false,
    visibility: row.visibility,
    operators: row.operators,
    routines_enabled: row.routines_enabled,
  };
}

export async function listUserGuilds(
  db: Queryable,
  orgId: string,
  userId: string,
): Promise<GuildRow[]> {
  return listGuildsForUser(db, orgId, userId);
}

/** Adds a guild with its notes folder; a folder that cannot be made takes the guild back out. */
export async function addGuild(
  services: Pick<GuildServices, "db" | "notes">,
  draft: GuildDraft,
  now: Date,
): Promise<GuildRow> {
  const { db, notes } = services;
  const { guild } = draft;
  await insertGuild(db, guild, now);
  try {
    await notes.createGuild(draft.orgSlug, guild.name);
  } catch (error) {
    await deleteGuildRow(db, guild.guildId);
    throw error;
  }
  const created = await getGuild(db, guild.guildId);
  if (created === null) {
    throw new Error("guild not found after create");
  }
  return created;
}

/** Creates a guild in the organisation within its policy's guild cap, with the creator as its admin. */
export async function createGuild(
  services: GuildServices,
  org: GuildOrg,
  creator: GuildActor,
  request: GuildRequest,
): Promise<GuildRow> {
  const { db, policy } = services;
  const name = validateGuildName(request.name);
  const about = validateAbout(request.about);
  const description = validateGuildDescription(request.description);
  const visibility = validateVisibility(request.visibility);
  await assertCanCreateGuild(policy, db, org.id);
  const guild = {
    guildId: newId("guild"),
    name,
    orgId: org.id,
    about,
    description,
    visibility,
    creatorUserId: creator.id,
  };
  try {
    return await addGuild(services, { guild, orgSlug: org.slug }, new Date());
  } catch (error) {
    throw nameConflict(error);
  }
}

/** Refuses adding `adding` agents to the guild past its agent limit; no guild has the default limit and no agents. */
export async function assertGuildAgentRoom(
  db: Queryable,
  guildId: string | null,
  adding: number,
): Promise<void> {
  if (adding <= 0) {
    return;
  }
  const row = guildId ? await getGuild(db, guildId) : null;
  const limit = Number(row?.max_agents ?? DEFAULT_GUILD_AGENTS);
  const cap = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_GUILD_AGENTS;
  const count = guildId ? await countGuildAgents(db, guildId) : 0;
  if (count + adding > cap) {
    throw new GuildAgentLimitError(cap);
  }
}

/** The change-log entry for a guild's about and description going from `before` to `after`; null when neither changed. */
export function guildTextChange(
  guildId: string,
  before: GuildTextRow,
  after: GuildTextRow,
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
async function changeGuild(
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

/** Changes a guild's about and description, each validated, logged against `actor`. Null when there is no such guild. */
export async function updateGuildText(
  db: Queryable,
  guildId: string,
  patch: GuildTextPatch,
  actor: ChangeActor,
): Promise<GuildRow | null> {
  return changeGuild(db, guildId, validateGuildTextPatch(patch), actor);
}

/** Refuses a rename while the guild is being deleted or one of its agents is generating. */
async function assertRenameable(services: GuildServices, guildId: string): Promise<void> {
  const { generation } = services;
  if (generation === null) {
    return;
  }
  if (generation.isDeletingGuild(guildId)) {
    throw new GuildError(409, "guild is being deleted");
  }
  const members = await listAgents(services.db, guildId);
  if (members.some((row) => generation.isAgentBusy(row.id))) {
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
    await changeGuild(services.db, guild.id, { name: guild.name }, userActor(actor));
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
    row = await changeGuild(db, guild.id, changes, userActor(actor));
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
  await services.generation.deleteGuild(guild.id);
}
