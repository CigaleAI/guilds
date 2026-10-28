import { operatorActor } from "../artifacts/actors.js";
import { listCollections } from "../artifacts/collections.js";
import type { ArtifactActor } from "../artifacts/types.js";
import type {
  CollectionColumn,
  ApplyInventory,
  ApplyPreview,
  CollectionPlan,
  Harness,
  MachineChoice,
  NameDecision,
  PlannedAgent,
  PlannedConnection,
  PlannedInstall,
  PlannedSecret,
  PlatformSetup,
  RecipeFinding,
  RoleHarness,
  RoleModel,
  RecipeDocument,
  RecipeRole,
} from "../db/schema/index.js";
import { harnessesOn, harnessOffMessage, harnessOf, isHarness, isHarnessOff } from "../coding/harnesses.js";
import { listServers } from "../connectors/servers.js";
import { agentNameTaken, listAgents } from "../db/agents.js";
import { getGuild } from "../db/guilds.js";
import { listMachines } from "../db/machines.js";
import { listMcpConnections } from "../db/mcp.js";
import type { OrgMembershipRow } from "../db/orgs.js";
import type { RecipeRow } from "../db/recipes.js";
import { listSecrets } from "../db/secrets.js";
import type { UserRow } from "../db/users.js";
import { GITHUB_SLUG } from "../github/index.js";
import { validateGuildName } from "../guilds/validation.js";
import { validateAgentName } from "../agents/validation.js";
import { integrationForConnector } from "../instance/integrations.js";
import { parseModelId } from "../llm/providers.js";
import { hostsOnlyVisible, visibleGuildIds } from "../machines/access.js";
import {
  MAX_AGENTS_PER_MACHINE,
  agentMinimum,
  agentsMinimum,
  belowMinimumMessage,
  machineSize,
  machineWithAgentsFromRow,
  plannedLoad,
  sizeMeets,
  type AgentNeeds,
  type MachineSize,
  type MachineWithAgents,
} from "../machines/index.js";
import { oauthSetupState } from "../oauth/index.js";
import type {
  ApplyChoices,
  ConnectionDecision,
  HarnessDecision,
  ModelDecision,
  RecipeApply,
  SecretDecision,
} from "./apply.js";
import { validationContext } from "./apply.js";
import { RecipeError } from "./errors.js";
import type { ValidationContext } from "./findings.js";
import { prepareRecipeForApply, roleBrowses, roleCodes, roleTaskText, schedulesForRole } from "./prepare.js";
import { unreviewedFields } from "./review.js";
import { applyBlockingErrors, validateRecipe } from "./validate.js";

// The preview of an apply: what it creates from the recipe, what it reuses of the organisation,
// and what blocks it, with the choices the operator makes on it.

/** Who reads the organisation on a preview; a preview only reads. */
function previewActor(org: OrgMembershipRow, user?: UserRow): ArtifactActor {
  return operatorActor({ orgId: org.id, actorId: user?.id ?? org.id, actorName: user?.name ?? "operator" });
}

function machineChoice(machine: MachineWithAgents, minimum: MachineSize): MachineChoice {
  const size = machineSize(machine);
  const planned = plannedLoad(machine.agents);
  return {
    id: machine.id,
    name: machine.name,
    box: machine.box,
    cpu: size.cpu,
    memory_mib: size.memory_mib,
    planned_cpu: planned.cpu,
    planned_mib: planned.memory_mib,
    agents: machine.agents.length,
    fits: sizeMeets(size, minimum),
  };
}

/** What each role of the recipe has on that sets its minimum. */
function rolesNeeds(recipe: RecipeDocument): Array<AgentNeeds & { role: string }> {
  return recipe.roles.map((role) => ({ role: role.role, browser: roleBrowses(role), coding: roleCodes(role) }));
}

/**
 * What blocks the roles on a machine: a role whose minimum the machine is below, more roles than
 * the machine has room for under `maxAgents`, or agents of a guild the operator cannot see on it.
 */
export function machineFindings(
  recipe: RecipeDocument,
  machine: MachineWithAgents,
  rules: { maxAgents: number; private: boolean },
): RecipeFinding[] {
  const findings: RecipeFinding[] = [];
  const size = machineSize(machine);
  for (const needs of rolesNeeds(recipe)) {
    if (!sizeMeets(size, agentMinimum(needs))) {
      findings.push({
        code: "machine.size",
        severity: "error",
        path: "machine_id",
        message: belowMinimumMessage(needs.role, needs, machine),
      });
    }
  }
  const room = Math.max(0, rules.maxAgents - machine.agents.length);
  if (recipe.roles.length > room) {
    findings.push({
      code: "machine.full",
      severity: "error",
      path: "machine_id",
      message: `${machine.name} has room for ${room} more agents`,
    });
  }
  if (rules.private) {
    findings.push({
      code: "machine.private",
      severity: "error",
      path: "machine_id",
      message: `${machine.name} hosts agents of a guild you cannot see; choose another machine`,
    });
  }
  return findings;
}

type MachinePlan = {
  machines: MachineChoice[];
  machineId: string | null;
  minimum: MachineSize;
  adds: MachineSize;
  findings: RecipeFinding[];
};

/**
 * The machine the roles go on: the one chosen, else the organisation's only one; null while
 * several wait for a choice, which the apply form makes. With the smallest machine every role
 * runs on, and the planned load the roles add. The findings of `machineFindings` on the machine
 * block the apply.
 */
async function planMachine(
  apply: RecipeApply,
  target: { orgId: string; user: UserRow | undefined },
  recipe: RecipeDocument,
  chosen: string | undefined,
): Promise<MachinePlan> {
  const rows = (await listMachines(apply.db, target.orgId)).map(machineWithAgentsFromRow);
  const needs = rolesNeeds(recipe);
  const minimum = agentsMinimum(needs);
  const adds = plannedLoad(needs);
  const machines = rows.map((row) => machineChoice(row, minimum));
  const machineId = chosen ?? (rows.length === 1 ? rows[0]!.id : null);
  if (machineId === null) {
    return { machines, machineId, minimum, adds, findings: [] };
  }
  const machine = rows.find((item) => item.id === machineId);
  if (!machine) {
    throw new RecipeError("machine not found", 404);
  }
  const { limits } = await apply.policy.standing(target.orgId);
  const visible = target.user ? await visibleGuildIds(apply.db, target.orgId, target.user.id) : null;
  const findings = machineFindings(recipe, machine, {
    maxAgents: Math.min(limits.maxAgentsPerMachine ?? MAX_AGENTS_PER_MACHINE, MAX_AGENTS_PER_MACHINE),
    private: visible !== null && !hostsOnlyVisible(machine, visible),
  });
  return { machines, machineId, minimum, adds, findings };
}

/**
 * Why a live table cannot stand in for a recipe collection: a recipe column
 * it lacks, one of another type, or a closed value list that rejects a value
 * the recipe's agents will write. Extra columns on the live table are fine.
 */
export function columnDifferences(wanted: CollectionColumn[], live: CollectionColumn[]): string[] {
  const differences: string[] = [];
  for (const column of wanted) {
    const match = live.find((item) => item.name === column.name);
    if (!match) {
      differences.push(`${column.name} is missing`);
      continue;
    }
    if (match.type !== column.type) {
      differences.push(`${column.name} is ${match.type}, the recipe needs ${column.type}`);
      continue;
    }
    const accepted = match.values;
    const rejected = accepted && column.values ? column.values.filter((value) => !accepted.includes(value)) : [];
    if (rejected.length) {
      differences.push(`${column.name} does not accept ${rejected.join(", ")}`);
    }
  }
  return differences;
}

export function collectionConflicts(collections: CollectionPlan[]): RecipeFinding[] {
  return collections
    .filter((item) => item.action === "conflict")
    .map((item) => ({
      code: "collection.conflict",
      severity: "error",
      path: `collections.${item.name}`,
      message:
        item.scope === "guild"
          ? `collection ${item.name} cannot belong to this guild: ${item.differences.join("; ")}; rename the recipe collection`
          : `collection ${item.name} already exists in the organisation with different columns ` +
            `(${item.differences.join("; ")}); rename the recipe collection`,
    }));
}

/**
 * Matches each recipe collection against the organisation's live tables: a
 * free name is created, a table whose columns accept every recipe column is
 * reused, and anything else is a conflict the operator resolves by renaming.
 */
async function planCollections(apply: RecipeApply, actor: ArtifactActor, recipe: RecipeDocument): Promise<CollectionPlan[]> {
  if (!recipe.collections.length) {
    return [];
  }
  const live = await listCollections(apply.artifacts, actor);
  const byName = new Map(live.map((item) => [item.name, item]));
  return recipe.collections.map((collection): CollectionPlan => {
    const existing = byName.get(collection.name);
    if (!existing) {
      return { ...collection, action: "create", collection_id: null, differences: [] };
    }
    // A guild's own table cannot be shared, so an existing name is a conflict.
    if (collection.scope === "guild") {
      return {
        ...collection,
        action: "conflict",
        collection_id: existing.id,
        differences: [`the organisation already has a table called ${collection.name}`],
      };
    }
    const differences = columnDifferences(collection.columns, existing.columns);
    return { ...collection, action: differences.length ? "conflict" : "reuse", collection_id: existing.id, differences };
  });
}

function resolveNames(recipe: RecipeDocument, decisions: NameDecision[]): Map<string, string> {
  const chosen = new Map(decisions.map((item) => [item.role, item.name]));
  return new Map(recipe.roles.map((role) => [role.role, validateAgentName(chosen.get(role.role) || role.name_suggestion)]));
}

/** The names among `names` another agent already goes by. */
async function nameCollisions(apply: RecipeApply, names: Iterable<string>): Promise<string[]> {
  const collisions: string[] = [];
  for (const name of names) {
    if (await agentNameTaken(apply.db, name)) {
      collisions.push(name);
    }
  }
  return collisions;
}

async function planConnections(
  apply: RecipeApply,
  orgId: string,
  recipe: RecipeDocument,
  decisions: ConnectionDecision[],
): Promise<PlannedConnection[]> {
  const connections = await listMcpConnections(apply.db, { orgId });
  const servers = await listServers(apply.db, { owner: { visibleTo: orgId } });
  const bySlug = new Map(servers.map((row) => [row.slug, row]));
  const chosen = new Map(decisions.map((item) => [item.server, item]));
  return recipe.connections.map((connection) => {
    const server = bySlug.get(connection.server);
    const reusable = connections.filter(
      (row) =>
        row.mcp_server_id === server?.id &&
        (row.owner_scope === "org" || row.owner_scope === "platform") &&
        row.status === "connected",
    );
    const decision = chosen.get(connection.server);
    return {
      server: connection.server,
      auth: connection.auth,
      recommended_scope: connection.recommended_scope === "org" ? "guild" : connection.recommended_scope,
      reusable: reusable.map((row) => ({ id: row.id, owner_scope: row.owner_scope, status: row.status })),
      action: decision?.action ?? (reusable.length ? "reuse" : "create"),
      connection_id: decision?.connection_id ?? reusable[0]?.id ?? null,
      setup: connection.setup,
      resources: connection.resources ?? [],
    };
  });
}

/** A recipe secret collides when its name is taken in the organisation; reuse is then the default. */
async function planSecrets(
  apply: RecipeApply,
  orgId: string,
  recipe: RecipeDocument,
  decisions: SecretDecision[],
): Promise<PlannedSecret[]> {
  const existing = await listSecrets(apply.db, orgId);
  const names = new Set(existing.map((row) => row.name));
  const chosen = new Map(decisions.map((item) => [item.name, item]));
  return recipe.secrets.map((secret) => {
    const collision = names.has(secret.name);
    const decision = chosen.get(secret.name);
    return {
      name: secret.name,
      description: secret.description,
      collision,
      action: decision?.action ?? (collision ? "reuse" : "create"),
      dest_name: decision?.dest_name ?? secret.name,
      recommended_scope: secret.recommended_scope === "org" ? "guild" : secret.recommended_scope,
      roles: secret.roles,
    };
  });
}

/** The connectors the recipe needs that the box lacks and apply installs: from the recipe, or the registry. */
function plannedInstalls(recipe: RecipeDocument, ctx: ValidationContext): PlannedInstall[] {
  return recipe.connections
    .filter((connection) => !ctx.publishedServers.has(connection.server))
    .flatMap((connection): PlannedInstall[] => {
      if (connection.manifest) {
        const manifest = connection.manifest;
        return [
          {
            server: connection.server,
            from: "recipe",
            display_name: manifest.display_name,
            description: manifest.description,
            url: manifest.endpoint?.url ?? "",
            auth: manifest.auth.kind,
          },
        ];
      }
      const offered = ctx.registryConnectors?.get(connection.server);
      return offered ? [{ server: connection.server, from: "registry", ...offered }] : [];
    });
}

/**
 * The connectors the recipe needs that the box has but a platform admin has not set up: a
 * connection's server, and GitHub when the recipe lists repositories. The apply goes on; these
 * steps cannot connect until the integration is filled under Admin, Platform keys.
 */
async function setupsNeeded(apply: RecipeApply, orgId: string, recipe: RecipeDocument): Promise<PlatformSetup[]> {
  const wanted = new Set(recipe.connections.map((connection) => connection.server));
  if (recipe.repositories.length) {
    wanted.add(GITHUB_SLUG);
  }
  const rows = (await listServers(apply.db, { owner: { visibleTo: orgId }, enabled: true })).filter(
    (row) => wanted.has(row.slug) && oauthSetupState(row) === "unsupported",
  );
  return rows.map((row) => {
    const integration = integrationForConnector(row.manifest);
    return {
      server: row.slug,
      integration: integration?.id ?? null,
      label: integration?.label ?? row.manifest.display_name,
    };
  });
}

/** The recipe's recommended model for a role, when it names one. */
function recommendedModel(role: RecipeRole): string | null {
  return typeof role.config.model === "string" && role.config.model.trim() ? role.config.model.trim() : null;
}

/** The models a role may run: one of a connected provider, and a coding provider only for a coding role. */
function modelFits(role: RecipeRole, connected: Set<string>, id: string | null): id is string {
  const parsed = id ? parseModelId(id) : null;
  return Boolean(parsed && connected.has(parsed.provider.id) && (roleCodes(role) || parsed.provider.kind !== "coding"));
}

/** The models a preview may pick from: the organisation's connected providers and its default model. */
type ModelOffer = { connected: Set<string>; defaultModel: string | null };

/**
 * The model each role is created with: the operator's choice, else the recommendation when the
 * organisation has its provider, else the organisation's default, else none.
 */
function resolveModels(recipe: RecipeDocument, decisions: ModelDecision[], offer: ModelOffer): RoleModel[] {
  const chosen = new Map(decisions.map((item) => [item.role, String(item.model ?? "").trim()]));
  return recipe.roles.map((role) => {
    const fits = (id: string | null): id is string => modelFits(role, offer.connected, id);
    const recommended = recommendedModel(role);
    const choice = chosen.get(role.role) || null;
    if (choice && !parseModelId(choice)) {
      throw new RecipeError(`models.${role.role}: model must be {provider}/{model}`);
    }
    if (choice && !fits(choice)) {
      throw new RecipeError(`models.${role.role}: ${choice} is not offered to this role`);
    }
    const model = choice ?? (fits(recommended) ? recommended : fits(offer.defaultModel) ? offer.defaultModel : null);
    return { role: role.role, recommended, model };
  });
}

/** The harness the recipe names for a coding role; null when it names none, or one the box turns off. */
function recommendedHarness(role: RecipeRole): Harness | null {
  const harness = harnessOf(role.config);
  return harness !== null && !isHarnessOff(harness) ? harness : null;
}

/** The harness the operator chose for a role, or null; refuses one that is unknown or turned off. */
function chosenHarness(role: string, choice: string | null): Harness | null {
  if (choice === null) {
    return null;
  }
  if (!isHarness(choice)) {
    throw new RecipeError(`harnesses.${role}: harness must be one of ${harnessesOn().join(", ")}`);
  }
  if (isHarnessOff(choice)) {
    throw new RecipeError(`harnesses.${role}: ${harnessOffMessage(choice)}`);
  }
  return choice;
}

/** The harness each coding role is created with: the operator's choice, else the recipe's. */
function resolveHarnesses(recipe: RecipeDocument, decisions: HarnessDecision[]): RoleHarness[] {
  const chosen = new Map(decisions.map((item) => [item.role, String(item.harness ?? "").trim()]));
  for (const role of chosen.keys()) {
    const found = recipe.roles.find((item) => item.role === role);
    if (!found || !roleCodes(found)) {
      throw new RecipeError(`harnesses.${role}: only a coding role takes a harness`);
    }
  }
  return recipe.roles.filter(roleCodes).map((role) => {
    const recommended = recommendedHarness(role);
    const choice = chosenHarness(role.role, chosen.get(role.role) || null);
    return { role: role.role, recommended, harness: choice ?? recommended };
  });
}

/** The harnesses the preview resolved, by role. */
export function roleHarnessMap(harnesses: RoleHarness[]): Map<string, Harness> {
  return new Map(harnesses.flatMap((item) => (item.harness ? [[item.role, item.harness] as const] : [])));
}

/** The models the preview resolved, by role. */
export function roleModelMap(models: RoleModel[]): Map<string, string> {
  return new Map(models.flatMap((item) => (item.model ? [[item.role, item.model] as const] : [])));
}

/** The parts of the plan the inventory lists beside the recipe's own. */
type InventoryPlan = {
  guildName: string;
  names: Map<string, string>;
  connections: PlannedConnection[];
  secrets: PlannedSecret[];
  collections: CollectionPlan[];
};

function inventoryFromRecipe(recipe: RecipeDocument, plan: InventoryPlan): ApplyInventory {
  return {
    guild: { name: plan.guildName, about: recipe.guild.about, objective: recipe.guild.objective },
    agents: recipe.roles.map((role) => ({
      role: role.role,
      name: plan.names.get(role.role) ?? role.name_suggestion,
      focus: role.focus,
      model: typeof role.config.model === "string" ? role.config.model : "",
      browser: roleBrowses(role),
      coding: roleCodes(role),
      task: roleTaskText(role, recipe),
      native_tools: Object.entries(role.native_tools)
        .filter(([, enabled]) => enabled)
        .map(([name]) => name),
    })),
    collections: plan.collections,
    notes: recipe.notes.map((item) => ({
      key: item.key,
      level: item.level,
      role: item.role ?? null,
      guild: item.guild ?? null,
      writers: item.writers,
    })),
    scripts: recipe.roles.flatMap((role) =>
      role.scripts.map((item) => ({ role: role.role, name: item.name, description: item.description })),
    ),
    routines: recipe.roles.flatMap((role) =>
      schedulesForRole(role, recipe).map((item) => ({
        role: role.role,
        key: item.key,
        cron: item.cron ?? null,
        window: item.window ?? null,
        description: item.description,
        instruction: item.instruction,
      })),
    ),
    connections: plan.connections,
    secrets: plan.secrets,
    repositories: recipe.repositories,
  };
}

/** The empty guild the recipe fills, when the operator picked one; refuses one of another organisation or with agents. */
async function destinationGuild(apply: RecipeApply, orgId: string, guildId: string | undefined): Promise<string | null> {
  if (!guildId) {
    return null;
  }
  const guild = await getGuild(apply.db, guildId);
  if (!guild || guild.org_id !== orgId) {
    throw new RecipeError("destination guild not found", 404);
  }
  if ((await listAgents(apply.db, guild.id)).length) {
    throw new RecipeError("destination guild is not empty");
  }
  return guild.id;
}

/** Where a preview reads from: the organisation, the recipe, and the operator who previews it. */
export type PreviewSource = { org: OrgMembershipRow; recipeRow: RecipeRow; user?: UserRow | undefined };

/** The recipe settled with the preview's choices, and what validating it in the organisation found. */
async function preparedRecipe(
  apply: RecipeApply,
  source: PreviewSource,
  choices: ApplyChoices,
): Promise<{ recipe: RecipeDocument; unreviewed: string[]; ctx: ValidationContext; findings: RecipeFinding[]; models: RoleModel[]; harnesses: RoleHarness[] }> {
  const recipe = source.recipeRow.body;
  const unreviewed = unreviewedFields(recipe);
  const ctx = await validationContext(apply, source.org.id, recipe);
  ctx.groupLimit = recipe.guild.group_agent_message_limit;
  const findings = validateRecipe(recipe, ctx);
  const models = resolveModels(recipe, choices.models ?? [], {
    connected: ctx.connectedProviders ?? new Set(),
    defaultModel: await apply.models.defaultModel(source.org.id),
  });
  const harnesses = resolveHarnesses(recipe, choices.harnesses ?? []);
  const prepared = prepareRecipeForApply(recipe, { models: roleModelMap(models), harnesses: roleHarnessMap(harnesses) });
  return { recipe: prepared, unreviewed, ctx, findings, models, harnesses };
}

/** What applying the recipe with `choices` does, and what blocks it. */
export async function previewApply(
  apply: RecipeApply,
  source: PreviewSource,
  choices: ApplyChoices = {},
): Promise<ApplyPreview> {
  const { org, recipeRow, user } = source;
  const { recipe, unreviewed, ctx, findings, models, harnesses } = await preparedRecipe(apply, source, choices);
  const collections = await planCollections(apply, previewActor(org, user), recipe);
  findings.push(...collectionConflicts(collections));
  const errors = applyBlockingErrors(findings);
  const names = resolveNames(recipe, choices.names ?? []);
  const collisions = await nameCollisions(apply, names.values());
  const guildName = validateGuildName(choices.guild_name || recipe.guild.name_suggestion);
  const guildId = await destinationGuild(apply, org.id, choices.guild_id);
  const connections = await planConnections(apply, org.id, recipe, choices.connections ?? []);
  const secrets = await planSecrets(apply, org.id, recipe, choices.secrets ?? []);
  const placement = await planMachine(apply, { orgId: org.id, user }, recipe, choices.machine_id);
  findings.push(...placement.findings);
  errors.push(...applyBlockingErrors(placement.findings));
  return {
    recipe_id: recipeRow.id,
    recipe_name: recipe.meta.name,
    guild_name: guildName,
    guild_id: guildId,
    names: [...names.entries()].map(([role, name]) => ({ role, name })),
    models,
    harnesses,
    machines: placement.machines,
    machine_id: placement.machineId,
    minimum_cpu: placement.minimum.cpu,
    minimum_mib: placement.minimum.memory_mib,
    adds_cpu: placement.adds.cpu,
    adds_mib: placement.adds.memory_mib,
    collisions,
    connections,
    installs: plannedInstalls(recipe, ctx),
    setups: await setupsNeeded(apply, org.id, recipe),
    secrets,
    collections,
    findings,
    errors,
    unreviewed,
    remaining: {
      agents: ctx.remainingAgents,
      browser_agents: ctx.remainingBrowserAgents,
      coding_agents: ctx.remainingCodingAgents,
    },
    creates: inventoryFromRecipe(recipe, { guildName, names, connections, secrets, collections }),
  };
}

/** The agents an apply names, with the agent each role's skeleton created. */
export function plannedAgents(names: Map<string, string>, roleToAgent: Map<string, string>): PlannedAgent[] {
  return [...names.entries()].map(([role, name]) => ({ role, name, agent_id: roleToAgent.get(role) }));
}
