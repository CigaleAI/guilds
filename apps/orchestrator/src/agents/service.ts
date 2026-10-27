import {
  inspectTaskEmbeds,
  taskEmbedActor,
  type ArtifactActor,
  type ArtifactStore,
} from "../artifacts/index.js";
import {
  getAgent,
  listAgents,
  updateAgentConfig,
  type AgentConfigPatch,
  type AgentRow,
} from "../db/agents.js";
import { GuildNameTaken } from "../db/errors.js";
import type { GuildRow } from "../db/guilds.js";
import { isPlainRecord } from "../db/json.js";
import { isUniqueViolation, type Queryable } from "../db/pg.js";
import type { GenerationLoop } from "../generation/index.js";
import { assertGuildAgentRoom, guildAgentRoom } from "../guilds/validation.js";
import { newId } from "../lib/ids.js";
import { assertModelConnected, type ModelCredentialsProvider } from "../llm/credentials.js";
import { placeAgent, type Placement } from "../machines/placement.js";
import type { NotesStore } from "../notes/store.js";
import {
  assertCanCreateAgent,
  assertCanEnableBrowser,
  assertCanEnableCoding,
  orgCounts,
  type OrgPolicy,
} from "../policy/index.js";
import { AgentError } from "./errors.js";
import { agentDatabase, persistAgent } from "./persist.js";
import {
  AgentValidationError,
  assertCodingAgent,
  browserLanguageOf,
  validateAgentName,
  validateAvatarColor,
  validateAvatarShape,
  validateConfig,
  validateFocus,
  validateWakeTriggers,
  withCodingLimits,
  type AgentConfig,
} from "./validation.js";
import { agentConfigObject, agentItem } from "./view.js";

/** What agents are created, changed, moved and deleted through, built once from the app's services. */
export type AgentServices = {
  db: Queryable;
  notes: NotesStore;
  artifacts: ArtifactStore | null;
  policy: OrgPolicy;
  modelCredentials: ModelCredentialsProvider;
  /** The generation loop that runs the agents; absent on a box without one. */
  generation: Pick<
    GenerationLoop,
    "deleting_guild" | "agent_is_busy" | "delete_agent" | "moveAgent" | "agentBrowserChanged"
  > | null;
};

/** A new agent as it is asked for, before validation. */
export type AgentDraft = {
  name: string;
  focus: string;
  wakeTriggers: string;
  avatarShape: string | undefined;
  avatarColor: string | undefined;
  config: unknown;
  machineId: unknown;
};

/** An agent's settings as a change asks for them, before validation; an undefined profile field stays as it is. */
export type AgentSettingsPatch = {
  config: unknown;
  machineId: unknown;
  name: string | undefined;
  focus: string | undefined;
  wakeTriggers: string | undefined;
  avatarShape: string | undefined;
  avatarColor: string | undefined;
};

/** An agent's validated config and the profile fields it changes. */
export type AgentSettings = { config: AgentConfig; profile: AgentConfigPatch };

/** A request's agent config as an object; an absent one is empty, anything else is refused. */
function configObject(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (!isPlainRecord(raw)) {
    throw new AgentValidationError("config must be an object");
  }
  return raw;
}

function generationOf(services: AgentServices): NonNullable<AgentServices["generation"]> {
  if (services.generation === null) {
    throw new AgentError(503, "generation is unavailable");
  }
  return services.generation;
}

function isBusy(services: AgentServices, agentId: string): boolean {
  return services.generation?.agent_is_busy(agentId) ?? false;
}

/** The 409 for a name another agent or an operator of the guild holds; any other error as it is. */
function nameConflict(error: unknown): unknown {
  if (error instanceof GuildNameTaken) {
    return new AgentError(409, error.message);
  }
  return isUniqueViolation(error) ? new AgentError(409, "agent name already exists") : error;
}

/** The guild's agents as its page lists them, each marked while it generates. */
export async function listGuildAgents(
  services: AgentServices,
  guildId: string,
): Promise<Array<Record<string, unknown>>> {
  return (await listAgents(services.db, guildId)).map((row) =>
    agentItem(row, isBusy(services, row.id)),
  );
}

/** The embeds of each agent's task that no longer resolve, by agent. */
export async function listBrokenTaskEmbeds(
  services: AgentServices,
  guild: GuildRow,
): Promise<Array<{ id: string; broken_embeds: string[] }>> {
  const agents = await listAgents(services.db, guild.id);
  const store = services.artifacts;
  const items = [];
  for (const row of agents) {
    const inspected = store
      ? await inspectTaskEmbeds(store, taskEmbedActor(guild.org_id, row), row.task ?? "")
      : [];
    items.push({
      id: row.id,
      broken_embeds: inspected.filter((item) => !item.ok).map((item) => item.href),
    });
  }
  return items;
}

/**
 * Creates an agent in the guild: validated, on a model the organisation has connected, within its
 * policy's caps and the guild's agent limit, and on the machine the draft names or the
 * organisation's only one.
 */
export async function createAgent(
  services: AgentServices,
  guild: GuildRow,
  operator: ArtifactActor,
  draft: AgentDraft,
): Promise<AgentRow> {
  const { db, policy } = services;
  if (services.generation?.deleting_guild(guild.id)) {
    throw new AgentError(409, "guild is being deleted");
  }
  const name = validateAgentName(draft.name);
  const focus = validateFocus(draft.focus);
  const wakeTriggers = validateWakeTriggers(draft.wakeTriggers);
  const avatarShape = validateAvatarShape(draft.avatarShape);
  const avatarColor = validateAvatarColor(draft.avatarColor);
  const config = validateConfig(withCodingLimits(configObject(draft.config)));
  assertCodingAgent(config);
  await assertModelConnected(services.modelCredentials, guild.org_id, config.model);
  const needs = { browser: config.browser, coding: config.coding };
  await assertCanCreateAgent(policy, orgCounts(db), guild.org_id, needs);
  await assertGuildAgentRoom(guildAgentRoom(db), guild.id, 1);
  const { machine, maxAgentsPerMachine } = await placeAgent(
    services,
    guild.org_id,
    operator.actorId,
    {
      requested: draft.machineId,
      needs,
    },
  );
  const agentId = newId("a");
  const agent = {
    agentId,
    guildId: guild.id,
    guildName: guild.name,
    orgSlug: guild.org_slug,
    name,
    config,
    now: new Date(),
    focus,
    wakeTriggers,
    avatarShape,
    avatarColor,
    orgId: guild.org_id,
    artifacts: services.artifacts,
    actor: { ...operator, guildId: guild.id, agentId },
    machineId: machine.id,
    maxAgentsPerMachine,
  };
  try {
    await persistAgent(agentDatabase(db), services.notes, agent);
  } catch (error) {
    throw nameConflict(error);
  }
  const created = await getAgent(db, agentId);
  if (created === null) {
    throw new Error("agent not found after create");
  }
  return created;
}

/** The profile fields a settings patch changes, each validated; an absent one is null. */
function validateAgentProfile(patch: AgentSettingsPatch): AgentConfigPatch {
  const optional = <T>(value: string | undefined, validate: (raw: string) => T): T | null =>
    value === undefined ? null : validate(value);
  return {
    name: optional(patch.name, validateAgentName),
    avatarShape: optional(patch.avatarShape, validateAvatarShape),
    avatarColor: optional(patch.avatarColor, validateAvatarColor),
    focus: optional(patch.focus, validateFocus),
    wakeTriggers: optional(patch.wakeTriggers, validateWakeTriggers),
  };
}

/** Refuses switching on a browser or coding the agent did not have when the policy's caps are reached. */
async function assertCanEnable(
  services: AgentServices,
  agent: AgentRow,
  config: AgentConfig,
  previous: Record<string, unknown>,
): Promise<void> {
  if (config.browser && !previous.browser) {
    await assertCanEnableBrowser(services.policy, orgCounts(services.db), agent.org_id, false);
  }
  if (config.coding && !previous.coding) {
    await assertCanEnableCoding(services.policy, orgCounts(services.db), agent.org_id);
  }
}

/** Refuses a rename while the agent's guild is being deleted or the agent is generating. */
function assertRenameable(services: AgentServices, agent: AgentRow): void {
  if (services.generation?.deleting_guild(agent.guild_id)) {
    throw new AgentError(409, "guild is being deleted");
  }
  if (isBusy(services, agent.id)) {
    throw new AgentError(409, "agent is already generating");
  }
}

/**
 * Writes the agent's new config and profile, on the machine `placement` chose: the agent moves
 * first, and moves back when the write fails.
 */
async function writeAgentSettings(
  services: AgentServices,
  agent: AgentRow,
  placement: Placement,
  change: AgentSettings,
): Promise<void> {
  const { machine, maxAgentsPerMachine, moves } = placement;
  const needs = { browser: change.config.browser, coding: change.config.coding };
  if (moves) {
    await generationOf(services).moveAgent(agent.id, machine.id, { maxAgentsPerMachine, needs });
  }
  let row;
  try {
    row = await updateAgentConfig(services.db, agent.id, change.config, new Date(), change.profile);
  } catch (error) {
    if (moves) {
      const previous = agentConfigObject(agent);
      await generationOf(services).moveAgent(agent.id, agent.machine_id, {
        needs: { browser: Boolean(previous.browser), coding: Boolean(previous.coding) },
      });
    }
    throw nameConflict(error);
  }
  if (row === null) {
    throw new AgentError(404, "agent not found");
  }
}

/** Moves a renamed agent's notes folder, putting its old name back when the folder cannot move. */
async function moveAgentNotes(
  services: AgentServices,
  agent: AgentRow,
  config: AgentConfig,
  name: string,
): Promise<void> {
  try {
    await services.notes.renameAgent(agent.org_slug, agent.guild_name, agent.name, name);
  } catch (error) {
    await updateAgentConfig(services.db, agent.id, config, new Date(), { name: agent.name });
    throw error;
  }
}

/**
 * Changes an agent's config and profile. A new config is validated and its model connected; a
 * browser or coding switched on is within the policy's caps; a rename waits while the agent
 * generates and moves its notes folder; a machine the config needs or the patch names moves the
 * agent there. A browser switched off, or on a new language, restarts.
 */
export async function reconfigureAgent(
  services: AgentServices,
  agent: AgentRow,
  userId: string,
  patch: AgentSettingsPatch,
): Promise<AgentRow> {
  const config = validateConfig(configObject(patch.config));
  const previous = agentConfigObject(agent);
  assertCodingAgent(config, previous);
  await assertModelConnected(services.modelCredentials, agent.org_id, config.model);
  const needs = { browser: config.browser, coding: config.coding };
  const placement = await placeAgent(services, agent.org_id, userId, {
    requested: patch.machineId,
    needs,
    machineId: agent.machine_id,
  });
  await assertCanEnable(services, agent, config, previous);
  const profile = validateAgentProfile(patch);
  const renamed =
    typeof profile.name === "string" && profile.name !== agent.name ? profile.name : null;
  if (renamed !== null) {
    assertRenameable(services, agent);
  }
  await writeAgentSettings(services, agent, placement, { config, profile });
  if (renamed !== null) {
    await moveAgentNotes(services, agent, config, renamed);
  }
  const browserOff = Boolean(previous.browser) && !config.browser;
  const newLanguage = config.browser && browserLanguageOf(previous) !== config.browser_language;
  if ((browserOff || newLanguage) && services.generation) {
    await services.generation.agentBrowserChanged(agent.id);
  }
  return reloadAgent(services.db, agent.id);
}

async function reloadAgent(db: Queryable, agentId: string): Promise<AgentRow> {
  const row = await getAgent(db, agentId);
  if (row === null) {
    throw new AgentError(404, "agent not found");
  }
  return row;
}

/** Moves the agent to the machine `machineId` names, within the policy's cap there. */
export async function moveAgentToMachine(
  services: AgentServices,
  agent: AgentRow,
  userId: string,
  machineId: unknown,
): Promise<AgentRow> {
  if (machineId === undefined || machineId === null) {
    throw new AgentError(422, "machine_id is required");
  }
  const config = agentConfigObject(agent);
  const { machine, maxAgentsPerMachine, moves } = await placeAgent(services, agent.org_id, userId, {
    requested: machineId,
    needs: { browser: config.browser === true, coding: config.coding === true },
    machineId: agent.machine_id,
  });
  if (moves) {
    await generationOf(services).moveAgent(agent.id, machine.id, { maxAgentsPerMachine });
  }
  return reloadAgent(services.db, agent.id);
}

/** Deletes an agent with its runs and notes, through the generation loop that runs it. */
export async function deleteAgent(services: AgentServices, agent: AgentRow): Promise<void> {
  await generationOf(services).delete_agent(agent.id);
}
