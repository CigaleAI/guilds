import { writeBinding } from "../access/bindings.js";
import { agentDatabase, persistAgent } from "../agents/persist.js";
import { writeAgentTask } from "../agents/task.js";
import { maxScriptsOf, validateConfig } from "../agents/validation.js";
import { operatorActor } from "../artifacts/actors.js";
import { createCollection, deleteCollection } from "../artifacts/collections.js";
import { ArtifactError, ownerPrefix, type ArtifactActor, type CollectionView } from "../artifacts/index.js";
import { writeNote } from "../artifacts/notes.js";
import { deleteAgent } from "../db/agents.js";
import { deleteGuild } from "../db/guilds.js";
import type { OrgMembershipRow } from "../db/orgs.js";
import { insertRecipeApply, type RecipeApplyRow } from "../db/recipe-applies.js";
import type { RecipeRow } from "../db/recipes.js";
import type { ApplyPlan, PlannedCollection, PlannedConnection } from "../db/schema/index.js";
import type { UserRow } from "../db/users.js";
import { guildDatabase, persistGuild } from "../guilds/persist.js";
import { assertGuildAgentRoom, GuildAgentLimitError, guildAgentRoom } from "../guilds/validation.js";
import type { ChangeActor } from "../lib/change-actor.js";
import { newId } from "../lib/ids.js";
import { assertCanCreateAgents, assertCanCreateGuild, assertCanPlaceAgents, machineCounts, orgCounts } from "../policy/index.js";
import { agentsOfRoles, raiseRecipeAccess } from "./access.js";
import type { ApplyChoices, RecipeApply } from "./apply.js";
import { checklistFromPlan, grantReusedSecrets, writeOverlays } from "./checklist.js";
import { RecipeConflictError, RecipeError } from "./errors.js";
import { parseRecipe } from "./parse.js";
import { plannedAgents, previewApply, roleHarnessMap, roleModelMap, type ApplyPreview, type CollectionPlan } from "./plan.js";
import { clippedInstruction, prepareRecipeForApply, roleBrowses, roleCodes, roleTaskText, schedulesForRole, withTrailingNewline } from "./prepare.js";
import { recipeNotePath, rewriteRecipePathsToDisplayPaths, rewriteRolesToNames } from "./rewrite.js";
import type { RecipeDocument, RecipeNote, RecipeRole } from "./schema.js";

// The skeleton of an apply: the guild, its agents with their tasks, scripts, paused routines and
// native tools, the recipe's notes and collections with their access, and the reused connections'
// overlays. A failure removes what the skeleton created so far.

/** What a skeleton is created from: the organisation, the operator who applies, and the recipe. */
export type SkeletonSource = { org: OrgMembershipRow; user: UserRow; recipeRow: RecipeRow };

/** The state of a skeleton while it is created: where it goes, who writes it, and what it made so far. */
type Skeleton = {
  apply: RecipeApply;
  source: SkeletonSource;
  guildId: string;
  guildName: string;
  machineId: string;
  maxAgentsPerMachine: number | null;
  now: Date;
  actor: ArtifactActor;
  names: Map<string, string>;
  roleToAgent: Map<string, string>;
  /** The display path each recipe note was written at, by every name the recipe links it with. */
  noteHref: Map<string, string>;
  created: { guild: boolean; agents: string[]; collections: string[] };
};

/** Refuses a preview the skeleton cannot be created from, naming what the operator still has to settle. */
function assertApplicable(preview: ApplyPreview, recipeRow: RecipeRow): string {
  if (recipeRow.status !== "ready") {
    throw new RecipeError("recipe is not approved");
  }
  if (preview.errors.length) {
    const messages = preview.errors.map((item) => item.message).filter(Boolean);
    throw new RecipeError(`recipe has blocking validation errors: ${messages.join("; ")}`);
  }
  if (preview.machine_id === null) {
    throw new RecipeError("choose the machine the agents go on");
  }
  if (preview.collisions.length) {
    throw new RecipeConflictError(`agent names already exist: ${preview.collisions.join(", ")}`);
  }
  const unchosen = preview.models.filter((item) => !item.model).map((item) => item.role);
  if (unchosen.length) {
    throw new RecipeError(`choose a model for ${unchosen.join(", ")}`);
  }
  const withoutHarness = preview.harnesses.filter((item) => !item.harness).map((item) => item.role);
  if (withoutHarness.length) {
    throw new RecipeError(`choose a harness for ${withoutHarness.join(", ")}`);
  }
  return preview.machine_id;
}

/** Refuses what the organisation's policy does not allow: the agents on the machine, a new guild, or the agents themselves. */
async function assertAllowed(
  apply: RecipeApply,
  target: { orgId: string; machineId: string; guildId: string | undefined },
  recipe: RecipeDocument,
): Promise<number | null> {
  const maxAgentsPerMachine = await assertCanPlaceAgents(
    apply.policy,
    machineCounts(apply.db),
    target.orgId,
    target.machineId,
    recipe.roles.length,
  );
  if (!target.guildId) {
    await assertCanCreateGuild(apply.policy, orgCounts(apply.db), target.orgId);
  }
  await assertCanCreateAgents(apply.policy, orgCounts(apply.db), target.orgId, {
    agents: recipe.roles.length,
    browserAgents: recipe.roles.filter(roleBrowses).length,
    codingAgents: recipe.roles.filter(roleCodes).length,
  });
  try {
    await assertGuildAgentRoom(guildAgentRoom(apply.db), target.guildId || null, recipe.roles.length);
  } catch (error) {
    if (error instanceof GuildAgentLimitError) {
      throw new RecipeConflictError(error.message);
    }
    throw error;
  }
  return maxAgentsPerMachine;
}

/** The operator writing as the agent `agentId` of the skeleton's guild. */
function agentOperator(skeleton: Skeleton, agentId: string): ArtifactActor {
  const { org, user } = skeleton.source;
  return operatorActor({ orgId: org.id, actorId: user.id, actorName: user.name, guildId: skeleton.guildId, agentId });
}

function rememberNoteHref(skeleton: Skeleton, note: RecipeNote, displayPath: string): void {
  skeleton.noteHref.set(note.id, displayPath);
  skeleton.noteHref.set(`recipe:${note.id}`, displayPath);
  skeleton.noteHref.set(recipeNotePath(note), displayPath);
}

/** Writes one recipe note at its level as `actor`, remembering where it went; returns its id. */
async function writeRecipeNote(skeleton: Skeleton, note: RecipeNote, actor: ArtifactActor): Promise<string> {
  const written = await writeNote(skeleton.apply.artifacts, actor, {
    level: note.level,
    key: note.key,
    content: note.body,
    title: note.key,
  });
  rememberNoteHref(skeleton, note, `${ownerPrefix(written.org_id, note.level, written.owner_id)}${written.key}`);
  return written.id;
}

async function createGuild(skeleton: Skeleton, recipe: RecipeDocument): Promise<void> {
  const { org, user } = skeleton.source;
  await persistGuild(guildDatabase(skeleton.apply.db), skeleton.apply.notes, {
    guildId: skeleton.guildId,
    name: skeleton.guildName,
    now: skeleton.now,
    orgId: org.id,
    orgSlug: org.slug,
    about: recipe.guild.about,
    description: recipe.guild.objective,
    groupAgentMessageLimit: recipe.guild.group_agent_message_limit,
    creatorUserId: user.id,
  });
  skeleton.created.guild = true;
}

async function createAgent(skeleton: Skeleton, role: RecipeRole, recipe: RecipeDocument): Promise<void> {
  const { org } = skeleton.source;
  const agentId = newId("a");
  await persistAgent(agentDatabase(skeleton.apply.db), skeleton.apply.notes, {
    agentId,
    guildId: skeleton.guildId,
    guildName: skeleton.guildName,
    orgSlug: org.slug,
    orgId: org.id,
    name: skeleton.names.get(role.role) ?? role.name_suggestion,
    config: validateConfig(role.config),
    now: skeleton.now,
    focus: role.focus,
    wakeTriggers: role.wake_triggers,
    task: withTrailingNewline(rewriteRolesToNames(roleTaskText(role, recipe), skeleton.names)),
    avatarShape: role.avatar_shape,
    avatarColor: role.avatar_color,
    artifacts: skeleton.apply.artifacts,
    actor: skeleton.actor,
    machineId: skeleton.machineId,
    maxAgentsPerMachine: skeleton.maxAgentsPerMachine,
  });
  skeleton.created.agents.push(agentId);
  skeleton.roleToAgent.set(role.role, agentId);
}

/**
 * Writes the recipe's notes, the organisation's and guild's before the agents exist and each
 * agent note under its role's agent once they do, then raises each note's access.
 */
async function writeNotes(skeleton: Skeleton, recipe: RecipeDocument): Promise<void> {
  const written: Array<{ note: RecipeNote; id: string }> = [];
  for (const note of recipe.notes.filter((item) => item.level !== "agent")) {
    written.push({ note, id: await writeRecipeNote(skeleton, note, skeleton.actor) });
  }
  for (const role of recipe.roles) {
    await createAgent(skeleton, role, recipe);
  }
  for (const note of recipe.notes.filter((item) => item.level === "agent")) {
    const agentId = note.role ? skeleton.roleToAgent.get(note.role) : skeleton.created.agents[0];
    if (agentId) {
      written.push({ note, id: await writeRecipeNote(skeleton, note, agentOperator(skeleton, agentId)) });
    }
  }
  for (const { note, id } of written) {
    await raiseRecipeAccess({ artifacts: skeleton.apply.artifacts, actor: skeleton.actor }, { kind: "note", id }, {
      access: note,
      guildId: skeleton.guildId,
      writerIds: agentsOfRoles(note.writers, skeleton.roleToAgent),
    });
  }
}

/** `text` with the recipe's note links turned into the display paths the notes were written at. */
function linkedText(skeleton: Skeleton, text: string, what: string): string {
  const rewritten = rewriteRecipePathsToDisplayPaths(text, skeleton.noteHref);
  if (rewritten.unresolved.length) {
    throw new RecipeError(`${what} has unresolved file links: ${rewritten.unresolved.join(", ")}`);
  }
  return rewritten.text;
}

async function writeNativeAccess(skeleton: Skeleton, role: RecipeRole, agentId: string): Promise<void> {
  const actor: ChangeActor = skeleton.actor;
  for (const [tool, enabled] of Object.entries(role.native_tools)) {
    await writeBinding(
      skeleton.apply.db,
      {
        bindingId: newId("bind"),
        catalogKind: "native_tool",
        catalogId: tool,
        scope: "agent",
        scopeId: agentId,
        enabled,
        connectionId: null,
      },
      skeleton.now,
      actor,
    );
  }
}

async function createScripts(skeleton: Skeleton, role: RecipeRole, agentId: string): Promise<void> {
  const scriptLimit = maxScriptsOf(role.config);
  if (role.scripts.length > scriptLimit) {
    throw new RecipeError(`${role.role} has ${role.scripts.length} scripts; max_scripts is ${scriptLimit}`);
  }
  for (const script of role.scripts) {
    await skeleton.apply.scripts.create(
      agentOperator(skeleton, agentId),
      agentId,
      script.name,
      script.description,
      script.source,
      script.parameters,
      { maxScripts: scriptLimit },
    );
  }
}

async function createRoutines(skeleton: Skeleton, role: RecipeRole, recipe: RecipeDocument, agentId: string): Promise<void> {
  for (const schedule of schedulesForRole(role, recipe)) {
    const instruction = linkedText(
      skeleton,
      rewriteRolesToNames(schedule.instruction || roleTaskText(role, recipe), skeleton.names),
      `${role.role} schedule ${schedule.key}`,
    );
    await skeleton.apply.schedules.create(
      skeleton.actor,
      agentId,
      { cron: schedule.cron, window: schedule.window },
      schedule.description,
      clippedInstruction(instruction),
      { paused: true },
    );
  }
}

/** Gives each role's agent its task with links resolved, its scripts, its paused routines and its native tools. */
async function fillAgent(skeleton: Skeleton, role: RecipeRole, recipe: RecipeDocument): Promise<void> {
  const agentId = skeleton.roleToAgent.get(role.role);
  if (!agentId) return;
  const named = withTrailingNewline(rewriteRolesToNames(roleTaskText(role, recipe), skeleton.names));
  const task = linkedText(skeleton, named, `${role.role} standing prompt`);
  if (task.trim()) {
    await writeAgentTask(skeleton.apply.db, agentOperator(skeleton, agentId), agentId, task);
  }
  await createScripts(skeleton, role, agentId);
  await createRoutines(skeleton, role, recipe, agentId);
  await writeNativeAccess(skeleton, role, agentId);
}

/** Creates a collection the plan creates; returns its id. */
async function createPlannedCollection(skeleton: Skeleton, item: CollectionPlan): Promise<string> {
  let created: CollectionView;
  try {
    created = await createCollection(skeleton.apply.artifacts, skeleton.actor, {
      name: item.name,
      purpose: item.purpose,
      columns: item.columns,
      ...(item.scope === "guild" ? { guildId: skeleton.guildId } : {}),
    });
  } catch (error) {
    if (error instanceof ArtifactError && error.status === 409) {
      throw new RecipeConflictError(`collection ${item.name} was created in the organisation while applying; preview again`);
    }
    throw error;
  }
  skeleton.created.collections.push(created.id);
  return created.id;
}

/** Creates or reuses each planned collection and raises its access; returns them as the plan keeps them. */
async function settleCollections(skeleton: Skeleton, planned: CollectionPlan[]): Promise<PlannedCollection[]> {
  const settled: PlannedCollection[] = [];
  for (const item of planned) {
    const collectionId = item.action === "create" ? await createPlannedCollection(skeleton, item) : item.collection_id;
    if (collectionId) {
      await raiseRecipeAccess(
        { artifacts: skeleton.apply.artifacts, actor: skeleton.actor },
        { kind: "collection", id: collectionId },
        { access: item, guildId: skeleton.guildId, writerIds: agentsOfRoles(item.writers, skeleton.roleToAgent) },
      );
    }
    settled.push({ name: item.name, action: item.action, collection_id: collectionId, guild: item.guild, writers: item.writers });
  }
  return settled;
}

/** Binds the recipe's overlays on each connection the plan reuses. */
async function bindReusedConnections(skeleton: Skeleton, planned: PlannedConnection[]): Promise<PlannedConnection[]> {
  const { org, recipeRow } = skeleton.source;
  const target = {
    recipe_id: recipeRow.id,
    org_id: org.id,
    guild_id: skeleton.guildId,
    names: plannedAgents(skeleton.names, skeleton.roleToAgent),
  };
  const bound: PlannedConnection[] = [];
  for (const connection of planned) {
    if (connection.action === "reuse" && connection.connection_id) {
      await writeOverlays(skeleton.apply, target, { server: connection.server, connectionId: connection.connection_id }, skeleton.actor);
      bound.push({ ...connection, bound: true });
    } else {
      bound.push({ ...connection });
    }
  }
  return bound;
}

/** Removes what the skeleton created so far; each removal goes on when another fails. */
async function rollBack(skeleton: Skeleton): Promise<void> {
  const { db, artifacts } = skeleton.apply;
  for (const agentId of [...skeleton.created.agents].reverse()) {
    await deleteAgent(db, agentId).catch(() => undefined);
  }
  if (skeleton.created.guild) {
    await deleteGuild(db, skeleton.guildId).catch(() => undefined);
  }
  for (const collectionId of [...skeleton.created.collections].reverse()) {
    await deleteCollection(artifacts, skeleton.actor, collectionId).catch(() => undefined);
  }
}

/** Creates everything the skeleton holds and records the apply with its plan and checklist. */
async function build(skeleton: Skeleton, recipe: RecipeDocument, preview: ApplyPreview, choices: ApplyChoices): Promise<RecipeApplyRow> {
  const { org, user, recipeRow } = skeleton.source;
  if (!choices.guild_id) {
    await createGuild(skeleton, recipe);
  }
  await writeNotes(skeleton, recipe);
  for (const role of recipe.roles) {
    await fillAgent(skeleton, role, recipe);
  }
  const plan: ApplyPlan = {
    names: plannedAgents(skeleton.names, skeleton.roleToAgent),
    collections: await settleCollections(skeleton, preview.collections),
    connections: await bindReusedConnections(skeleton, preview.connections),
    secrets: preview.secrets,
    activate_keys: choices.activate_keys ?? recipe.roles.flatMap((role) => schedulesForRole(role, recipe).map((item) => item.key)),
  };
  return insertRecipeApply(
    skeleton.apply.db,
    {
      applyId: newId("rpl"),
      orgId: org.id,
      recipeId: recipeRow.id,
      createdByUserId: user.id,
      guildId: skeleton.guildId,
      createdGuild: skeleton.created.guild,
      recipeBodyVersion: recipeRow.body_version,
      preview,
      plan,
      checklist: checklistFromPlan(recipe, plan),
      warnings: preview.findings,
    },
    skeleton.now,
  );
}

/**
 * Applies an approved recipe: creates its skeleton as previewed with `choices` and records the
 * apply with its open checklist. Reused secrets reach the new guild once the apply stands.
 */
export async function createSkeleton(
  apply: RecipeApply,
  source: SkeletonSource,
  choices: ApplyChoices = {},
): Promise<RecipeApplyRow> {
  const { org, user, recipeRow } = source;
  const preview = await previewApply(apply, source, choices);
  const machineId = assertApplicable(preview, recipeRow);
  const recipe = prepareRecipeForApply(parseRecipe(recipeRow.body), {
    models: roleModelMap(preview.models),
    harnesses: roleHarnessMap(preview.harnesses),
  });
  const maxAgentsPerMachine = await assertAllowed(apply, { orgId: org.id, machineId, guildId: choices.guild_id }, recipe);
  const guildId = choices.guild_id ?? newId("guild");
  const skeleton: Skeleton = {
    apply,
    source,
    guildId,
    guildName: preview.guild_name,
    machineId,
    maxAgentsPerMachine,
    now: new Date(),
    actor: operatorActor({ orgId: org.id, actorId: user.id, actorName: user.name, guildId }),
    names: new Map(preview.names.map((item) => [item.role, item.name])),
    roleToAgent: new Map(),
    noteHref: new Map(),
    created: { guild: false, agents: [], collections: [] },
  };
  let applied: RecipeApplyRow;
  try {
    applied = await build(skeleton, recipe, preview, choices);
  } catch (error) {
    await rollBack(skeleton);
    throw error;
  }
  // Granted once the apply stands: a rolled-back guild would take a secret whose only grant it held.
  return grantReusedSecrets(apply, applied, user);
}
