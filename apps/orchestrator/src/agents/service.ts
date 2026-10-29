import type { ArtifactActor } from "../artifacts/types.js";
import type { ArtifactStore } from "../artifacts/store.js";
import { ensureAgentRows } from "../artifacts/memory.js";
import {
  brokenTaskEmbeds,
  hashTaskContent,
  resolveTaskContent,
  taskDisplayPath,
} from "../artifacts/task.js";
import {
  deleteAgent as deleteAgentRow,
  getAgent,
  guildHasOperatorNamed,
  insertAgent,
  listAgents,
  updateAgentConfig,
  type AgentConfigPatch,
  type AgentPlacement,
  type AgentRow,
  type NewAgent,
} from "../db/agents.js";
import { GuildNameTaken, RowMissing } from "../db/errors.js";
import { recordFileChange } from "../db/file-changes.js";
import { getGuild, type GuildRow } from "../db/guilds.js";
import { isPlainRecord } from "../db/json.js";
import { isUniqueViolation, type Queryable, withTransaction } from "../db/pg.js";
import type { AgentConfig } from "../db/schema/index.js";
import type { GenerationLoop } from "../generation/index.js";
import type { AgentMachines } from "../generation/machines.js";
import { assertGuildAgentRoom } from "../guilds/service.js";
import { newId } from "../lib/ids.js";
import { assertModelConnected, type ModelCredentialsProvider } from "../llm/credentials.js";
import { freeSlot, placeAgent, placementMachine, type Placement } from "../machines/placement.js";
import type { NotesStore } from "../notes/store.js";
import {
  assertCanCreateAgent,
  assertCanEnableBrowser,
  assertCanEnableCoding,
  orgCounts,
  type OrgPolicy,
} from "../policy/index.js";
import { AgentError } from "./errors.js";
import { assertCodingAgent, validateAgentConfig, withCodingLimits } from "./config.js";
import {
  AgentValidationError,
  validateAgentName,
  validateAvatarColor,
  validateAvatarShape,
  validateFocus,
  validateWakeTriggers,
} from "./validation.js";
import { agentItem } from "./view.js";

/** What agents are created, changed, moved and deleted through, built once from the app's services. */
export type AgentServices = {
  db: Queryable;
  notes: NotesStore;
  artifacts: ArtifactStore | null;
  policy: OrgPolicy;
  modelCredentials: ModelCredentialsProvider;
  /** The generation loop that runs the agents; absent on a box without one. */
  generation:
    | (Pick<GenerationLoop, "isDeletingGuild" | "isAgentBusy" | "deleteAgent"> & {
        machines: Pick<AgentMachines, "moveAgent" | "agentBrowserChanged">;
      })
    | null;
};

/** A new agent as it is asked for, before validation. */
export type AgentRequest = {
  name: string;
  focus: string;
  wakeTriggers: string;
  avatarShape: string | undefined;
  avatarColor: string | undefined;
  config: unknown;
  machineId: unknown;
};

/**
 * A new agent as it is written: its row, the text its task is made from (the task template when
 * the text is blank), and the machine it goes on.
 */
export type AgentDraft = { agent: NewAgent; task: string; placement: AgentPlacement };

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
  return services.generation?.isAgentBusy(agentId) ?? false;
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
    items.push({ id: row.id, broken_embeds: store ? await brokenTaskEmbeds(store, row) : [] });
  }
  return items;
}

/**
 * Adds an agent to its guild, on the machine its placement names or else the organisation's only
 * one, in the lowest free slot there, with its task's creation logged against `actor`. The agent
 * gets its Memory in the artifact store, or its notes folder where there is no store; when that
 * fails, the agent goes again.
 */
export async function addAgent(
  services: Pick<AgentServices, "db" | "notes" | "artifacts">,
  draft: AgentDraft,
  actor: ArtifactActor,
  now: Date,
): Promise<AgentRow> {
  const { db, notes, artifacts } = services;
  const { agent, placement } = draft;
  const task = resolveTaskContent(draft.task, artifacts?.templatesRoot ?? "");
  const guild = await withTransaction(db, async (client) => {
    if (await guildHasOperatorNamed(client, agent.guildId, agent.name)) {
      throw new GuildNameTaken(agent.name, "operator");
    }
    const row = await getGuild(client, agent.guildId);
    if (!row) {
      throw new RowMissing("agent insert failed: guild not found");
    }
    const machine = await placementMachine(client, row.org_id, placement.machineId, {
      browser: agent.config.browser === true,
      coding: agent.config.coding === true,
    });
    const slot = await freeSlot(client, machine, placement.maxAgentsPerMachine ?? undefined);
    const inserted = await insertAgent(
      client,
      { ...agent, task, taskHash: hashTaskContent(task), machineId: machine.id, machineSlot: slot },
      now,
    );
    await recordFileChange(client, actor, {
      orgId: inserted.org_id,
      taskAgentId: agent.agentId,
      displayPath: taskDisplayPath(inserted.org_id, agent.agentId),
      operation: "create",
      version: inserted.task_version,
      createdAt: now,
    });
    return row;
  });
  try {
    if (artifacts) {
      await ensureAgentRows(artifacts, {
        orgId: actor.orgId,
        guildId: agent.guildId,
        agentId: agent.agentId,
        actor,
      });
    } else {
      await notes.createAgent(guild.org_slug, guild.name, agent.name, draft.task);
    }
  } catch (error) {
    await deleteAgentRow(db, agent.agentId);
    throw error;
  }
  const created = await getAgent(db, agent.agentId);
  if (created === null) {
    throw new Error("agent not found after create");
  }
  return created;
}

/**
 * Creates an agent in the guild: validated, on a model the organisation has connected, within its
 * policy's caps and the guild's agent limit, and on the machine the request names or the
 * organisation's only one.
 */
export async function createAgent(
  services: AgentServices,
  guild: GuildRow,
  operator: ArtifactActor,
  request: AgentRequest,
): Promise<AgentRow> {
  const { db, policy } = services;
  if (services.generation?.isDeletingGuild(guild.id)) {
    throw new AgentError(409, "guild is being deleted");
  }
  const name = validateAgentName(request.name);
  const focus = validateFocus(request.focus);
  const wakeTriggers = validateWakeTriggers(request.wakeTriggers);
  const avatarShape = validateAvatarShape(request.avatarShape);
  const avatarColor = validateAvatarColor(request.avatarColor);
  const config = validateAgentConfig(withCodingLimits(configObject(request.config)));
  assertCodingAgent(config);
  await assertModelConnected(services.modelCredentials, guild.org_id, config.model);
  const needs = { browser: config.browser, coding: config.coding };
  await assertCanCreateAgent(policy, orgCounts(db), guild.org_id, needs);
  await assertGuildAgentRoom(db, guild.id, 1);
  const { machine, maxAgentsPerMachine } = await placeAgent(
    services,
    guild.org_id,
    operator.actorId,
    {
      requested: request.machineId,
      needs,
    },
  );
  const agentId = newId("a");
  const draft: AgentDraft = {
    agent: { agentId, guildId: guild.id, name, config, focus, wakeTriggers, avatarShape, avatarColor },
    task: focus,
    placement: { machineId: machine.id, maxAgentsPerMachine },
  };
  try {
    return await addAgent(services, draft, { ...operator, guildId: guild.id, agentId }, new Date());
  } catch (error) {
    throw nameConflict(error);
  }
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
  if (services.generation?.isDeletingGuild(agent.guild_id)) {
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
    await generationOf(services).machines.moveAgent(agent.id, machine.id, { maxAgentsPerMachine, needs });
  }
  let row;
  try {
    row = await updateAgentConfig(
      services.db,
      agent.id,
      { config: change.config, ...change.profile },
      new Date(),
    );
  } catch (error) {
    if (moves) {
      const previous = agent.config;
      await generationOf(services).machines.moveAgent(agent.id, agent.machine_id, {
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
    await updateAgentConfig(services.db, agent.id, { config, name: agent.name }, new Date());
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
  const config = validateAgentConfig(configObject(patch.config));
  const previous = agent.config;
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
  const newLanguage = config.browser && previous.browser_language !== config.browser_language;
  if ((browserOff || newLanguage) && services.generation) {
    await services.generation.machines.agentBrowserChanged(agent.id);
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
  const config = agent.config;
  const { machine, maxAgentsPerMachine, moves } = await placeAgent(services, agent.org_id, userId, {
    requested: machineId,
    needs: { browser: config.browser === true, coding: config.coding === true },
    machineId: agent.machine_id,
  });
  if (moves) {
    await generationOf(services).machines.moveAgent(agent.id, machine.id, { maxAgentsPerMachine });
  }
  return reloadAgent(services.db, agent.id);
}

/** Deletes an agent with its runs and notes, through the generation loop that runs it. */
export async function deleteAgent(services: AgentServices, agent: AgentRow): Promise<void> {
  await generationOf(services).deleteAgent(agent.id);
}
