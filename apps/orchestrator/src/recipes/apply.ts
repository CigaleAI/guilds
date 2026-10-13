import { registryClient, type RegistryClient } from "../registry/client.js";
import { pickEntry, type RegistryIndex } from "../registry/index.js";
import { persistAgent } from "../agents/persist.js";
import { serverManifest } from "../connectors/load.js";
import { GITHUB_SLUG } from "../github/index.js";
import { integrationForConnector } from "../instance/integrations.js";
import { oauthSetupState } from "../oauth/index.js";
import { persistGuild } from "../guilds/persist.js";
import { GuildAgentLimitError, assertGuildAgentRoom, validateGuildName } from "../guilds/validation.js";
import {
  addMissingBrowserLanguage,
  addMissingFlags,
  addMissingCliScriptingAndMemory,
  addMissingRunLimits,
  addMissingTemperatureAndStepLimits,
  addMissingThinkingLevel,
  maxScriptsOf,
  validateAgentName,
} from "../agents/validation.js";
import { coreModelCredentials } from "../llm/credentials.js";
import { ModelsService } from "../llm/models.js";
import { parseModelId } from "../llm/providers.js";
import { operatorActor } from "../artifacts/grants.js";
import {
  ArtifactError,
  ownerPrefix,
  type ArtifactActor,
  type ArtifactStore,
  type CollectionColumn,
  type CollectionView,
} from "../artifacts/index.js";
import { newId } from "../lib/ids.js";
import { hostsOnlyVisible, visibleGuildIds } from "../machines/access.js";
import {
  MAX_AGENTS_PER_MACHINE,
  agentPlannedMib,
  machineAllowsCoding,
  machineSize,
  plannedMib,
  type MachineBox,
  type MachineWithAgents,
} from "../machines/index.js";
import { jsonObj } from "../db/json.js";
import type { Repositories } from "../db/repositories.js";
import type { NotesStore } from "../notes/store.js";
import type { Scripts } from "../scripts/catalog.js";
import type { Schedules } from "../schedules/service.js";
import {
  OPEN_POLICY,
  assertCanCreateAgents,
  assertCanCreateGuild,
  assertCanPlaceAgents,
  remaining,
  type OrgPolicy,
} from "../policy/index.js";
import { httpAccess } from "../http/access.js";
import { RecipeConflictError, RecipeError } from "./errors.js";
import {
  builderAuthor,
  parseRecipe,
  unreviewedFields,
  type RecipeCollection,
  type RecipeDocument,
  type RecipeRole,
  type RecipeSchedule,
} from "./schema.js";
import { applyBlockingErrors, validateRecipe, type RecipeFinding, type ValidationContext } from "./validate.js";
import { recipeNotePath, rewriteRecipeEmbedsToDisplayPaths, rewriteRolesToNames } from "./rewrite.js";
import { INSTRUCTION_MAX, validateCron } from "../schedules/cron.js";
import type { RecipeStore } from "./store.js";
import { accessOf, managesOrgSecrets } from "../secrets/access.js";

export type ApplyDeps = {
  repo: Repositories;
  recipes: RecipeStore;
  artifacts: ArtifactStore;
  notes: NotesStore;
  scripts: Scripts;
  schedules: Schedules;
  policy?: OrgPolicy;
  /** The registry a missing connector may install from: the box's `REGISTRY_URL` when absent, none when null. */
  registry?: RegistryClient | null;
  /** The organisation's connected providers and default model; core's own rows when absent. */
  models?: ModelsService;
};

type NameDecision = { role: string; name: string };
type ConnectionDecision = {
  server: string;
  action: "reuse" | "create";
  scope: "guild" | "agent";
  role?: string;
  connection_id?: string;
};
type SecretDecision = { name: string; action: "reuse" | "rename" | "skip"; dest_name?: string };
/** The model the operator picked for a role on the apply preview. */
type ModelDecision = { role: string; model: string };

/** A role's model on the preview: what the recipe recommends, and what apply will create it with. */
export type RoleModel = { role: string; recommended: string | null; model: string | null };

/**
 * What apply will do with one recipe collection: create it, reuse the live
 * table of that name, or stop because that table's columns differ.
 */
export type CollectionPlan = RecipeCollection & {
  action: "create" | "reuse" | "conflict";
  collection_id: string | null;
  differences: string[];
};

export type ApplyChoices = {
  guild_name?: string;
  guild_id?: string;
  names?: NameDecision[];
  models?: ModelDecision[];
  connections?: ConnectionDecision[];
  secrets?: SecretDecision[];
  activate_keys?: string[];
  /** The machine every role goes on; the organisation's only one when absent. */
  machine_id?: string;
};

/** A machine the preview offers, with the memory its agents plan to use and what the roles add. */
export type MachineChoice = {
  id: string;
  name: string;
  box: MachineBox;
  memory_mib: number;
  planned_mib: number;
  agents: number;
};

function machineChoice(machine: MachineWithAgents): MachineChoice {
  return {
    id: machine.id,
    name: machine.name,
    box: machine.box,
    memory_mib: machineSize(machine).memory_mib,
    planned_mib: plannedMib(machine.agents),
    agents: machine.agents.length,
  };
}

/** The planned memory the recipe's roles add to their machine. */
function rolesPlannedMib(recipe: RecipeDocument): number {
  return recipe.roles.reduce(
    (sum, role) =>
      sum + agentPlannedMib({ browser: Boolean(role.browser.required || role.config.browser), coding: role.config.coding === true }),
    0,
  );
}

/**
 * What blocks the roles on a machine: a coding role on a standard machine, more roles than the
 * machine has room for under `maxAgents`, or agents of a guild the operator cannot see on it.
 */
export function machineFindings(
  recipe: RecipeDocument,
  machine: MachineWithAgents,
  rules: { maxAgents: number; private: boolean },
): RecipeFinding[] {
  const findings: RecipeFinding[] = [];
  if (!machineAllowsCoding(machine.box)) {
    for (const role of recipe.roles.filter((item) => item.config.coding === true)) {
      findings.push({
        code: "machine.coding",
        severity: "error",
        path: `roles.${role.role}.config.coding`,
        message: `${role.role} codes and needs a code or custom machine; ${machine.name} is standard. Create or resize one in Settings, Machines.`,
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

function mapApply(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    org_id: row.org_id,
    recipe_id: row.recipe_id,
    created_by_user_id: row.created_by_user_id,
    guild_id: row.guild_id,
    created_guild: Boolean(row.created_guild),
    status: row.status,
    recipe_body_version: Number(row.recipe_body_version),
    preview: jsonObj(row.preview),
    plan: jsonObj(row.plan),
    checklist: jsonObj(row.checklist),
    warnings: jsonObj(row.warnings),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class RecipeApplyService {
  private models: ModelsService;

  constructor(public deps: ApplyDeps) {
    this.models =
      deps.models ?? new ModelsService({ repo: deps.repo, credentials: coreModelCredentials(deps.repo) });
  }

  private get policy(): OrgPolicy {
    return this.deps.policy ?? OPEN_POLICY;
  }

  /**
   * The model each role is created with: the operator's choice, else the recommendation when the
   * organisation has its provider, else the organisation's default, else none.
   */
  private resolveModels(
    recipe: RecipeDocument,
    decisions: ModelDecision[],
    connected: Set<string>,
    defaultModel: string | null,
  ): RoleModel[] {
    const chosen = new Map(decisions.map((item) => [item.role, String(item.model ?? "").trim()]));
    return recipe.roles.map((role) => {
      const coding = role.config.coding === true;
      const fits = (id: string | null): id is string => {
        const parsed = id ? parseModelId(id) : null;
        return Boolean(parsed && connected.has(parsed.provider.id) && (coding || parsed.provider.kind !== "coding"));
      };
      const recommended = typeof role.config.model === "string" && role.config.model.trim() ? role.config.model.trim() : null;
      const choice = chosen.get(role.role) || null;
      if (choice) {
        if (!parseModelId(choice)) {
          throw new RecipeError(`models.${role.role}: model must be {provider}/{model}`);
        }
        if (!fits(choice)) {
          throw new RecipeError(`models.${role.role}: ${choice} is not offered to this role`);
        }
      }
      const model = choice ?? (fits(recommended) ? recommended : fits(defaultModel) ? defaultModel : null);
      return { role: role.role, recommended, model };
    });
  }

  /**
   * What the registry offers among the connectors `recipe` names that the box lacks and the
   * recipe does not carry; empty while offline or when the index cannot be read.
   */
  private async registryOffers(
    recipe: RecipeDocument,
    servers: readonly string[],
  ): Promise<Map<string, { version: string; verified: boolean }>> {
    const missing = new Set(
      recipe.connections.filter((item) => !servers.includes(item.server) && !item.manifest).map((item) => item.server),
    );
    const client = this.deps.registry === undefined ? registryClient() : this.deps.registry;
    if (!missing.size || client === null) {
      return new Map();
    }
    let index: RegistryIndex;
    try {
      index = await client.index();
    } catch {
      return new Map();
    }
    const offers = new Map<string, { version: string; verified: boolean }>();
    for (const slug of missing) {
      const entry = pickEntry(index.connectors.filter((item) => item.slug === slug));
      if (entry) {
        offers.set(slug, { version: entry.version, verified: entry.verified });
      }
    }
    return offers;
  }

  /** The context a recipe validates against; given the recipe, what the registry offers for the connectors the box lacks. */
  async validationContext(orgId: string, recipe?: RecipeDocument): Promise<ValidationContext> {
    const { limits } = await this.policy.standing(orgId);
    const agents = await this.deps.repo.countOrgAgents(orgId);
    const browsers = await this.deps.repo.countOrgBrowserAgents(orgId);
    const coders = await this.deps.repo.countOrgCodingAgents(orgId);
    const servers = (await this.deps.repo.listMcpServers(orgId))
      .filter((row) => row.enabled !== false)
      .map((row) => String(row.slug));
    return {
      publishedServers: new Set(servers),
      ...(recipe ? { registryConnectors: await this.registryOffers(recipe, servers) } : {}),
      remainingAgents: remaining(limits.maxAgents, agents),
      remainingBrowserAgents: remaining(limits.maxBrowserAgents, browsers),
      remainingCodingAgents: remaining(limits.maxCodingAgents, coders),
      groupLimit: 20,
      connectedProviders: await this.models.connectedProviders(orgId),
    };
  }

  /**
   * The connectors the recipe needs that the box has but a platform admin has not set up: a
   * connection's server, and GitHub when the recipe lists repositories. The apply goes on; these
   * steps cannot connect until the integration is filled under Admin, Platform keys.
   */
  private async setupsNeeded(
    orgId: string,
    recipe: RecipeDocument,
  ): Promise<Array<{ server: string; integration: string | null; label: string }>> {
    const wanted = new Set(recipe.connections.map((connection) => connection.server));
    if (recipe.repositories.length) {
      wanted.add(GITHUB_SLUG);
    }
    const rows = (await this.deps.repo.listMcpServers(orgId)).filter(
      (row) => row.enabled !== false && wanted.has(String(row.slug)) && oauthSetupState(row) === "unsupported",
    );
    return rows.map((row) => {
      const manifest = serverManifest(row);
      const integration = manifest ? integrationForConnector(manifest) : null;
      return {
        server: String(row.slug),
        integration: integration?.id ?? null,
        label: integration?.label ?? manifest?.display_name ?? String(row.slug),
      };
    });
  }

  async preview(
    org: Record<string, unknown>,
    recipeRow: Record<string, unknown>,
    choices: ApplyChoices = {},
    user?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const recipe = parseRecipe(recipeRow.body);
    const unreviewed = unreviewedFields(recipe);
    const ctx = await this.validationContext(String(org.id), recipe);
    ctx.groupLimit = recipe.guild.group_agent_message_limit;
    const findings = validateRecipe(recipe, ctx);
    const models = this.resolveModels(
      recipe,
      choices.models ?? [],
      ctx.connectedProviders ?? new Set(),
      await this.models.defaultModel(String(org.id)),
    );
    const prepared = prepareRecipeForApply(recipe, ctx.publishedServers, roleModelMap(models));
    const collections = await this.planCollections(org, prepared, user);
    findings.push(...collectionConflicts(collections));
    const errors = applyBlockingErrors(findings);
    const names = this.resolveNames(prepared, choices.names ?? []);
    const collisions: string[] = [];
    for (const name of names.values()) {
      const existing = await this.deps.repo.pool.query(`SELECT id FROM agents WHERE name = $1`, [name]);
      if (existing.rows.length) {
        collisions.push(name);
      }
    }
    const guildName = validateGuildName(choices.guild_name || prepared.guild.name_suggestion);
    let destGuild: Record<string, unknown> | null = null;
    if (choices.guild_id) {
      destGuild = await this.deps.repo.getGuild(choices.guild_id);
      if (!destGuild || String(destGuild.org_id) !== String(org.id)) {
        throw new RecipeError("destination guild not found", 404);
      }
      const members = await this.deps.repo.listAgents(String(destGuild.id));
      if (members.some((row) => !row.archived_at)) {
        throw new RecipeError("destination guild is not empty");
      }
    }
    const connections = await this.planConnections(org, prepared, choices.connections ?? []);
    const secrets = await this.planSecrets(org, prepared, choices.secrets ?? []);
    const installs = prepared.connections
      .filter((connection) => !ctx.publishedServers.has(connection.server))
      .flatMap((connection): Array<Record<string, unknown>> => {
        if (connection.manifest) {
          return [
            {
              server: connection.server,
              from: "recipe",
              display_name: connection.manifest.display_name,
              description: connection.manifest.description,
              url: connection.manifest.endpoint?.url ?? "",
              auth: connection.manifest.auth.kind,
            },
          ];
        }
        const offered = ctx.registryConnectors?.get(connection.server);
        return offered ? [{ server: connection.server, from: "registry", ...offered }] : [];
      });
    const setups = await this.setupsNeeded(String(org.id), prepared);
    const placement = await this.planMachine(String(org.id), prepared, choices.machine_id, user);
    findings.push(...placement.findings);
    errors.push(...applyBlockingErrors(placement.findings));
    return {
      recipe_id: recipeRow.id,
      recipe_name: prepared.meta.name,
      guild_name: guildName,
      guild_id: destGuild ? destGuild.id : null,
      names: [...names.entries()].map(([role, name]) => ({ role, name })),
      models,
      machines: placement.machines,
      machine_id: placement.machineId,
      adds_mib: placement.addsMib,
      collisions,
      connections,
      installs,
      setups,
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
      creates: inventoryFromRecipe(prepared, names, connections, secrets, collections, guildName),
    };
  }

  /**
   * The machine the roles go on: the one chosen, else the organisation's only one. No machine
   * chosen among several, or the findings of `machineFindings` on the one chosen, block the apply.
   */
  private async planMachine(
    orgId: string,
    recipe: RecipeDocument,
    chosen: string | undefined,
    user: Record<string, unknown> | undefined,
  ): Promise<{ machines: MachineChoice[]; machineId: string | null; addsMib: number; findings: RecipeFinding[] }> {
    const rows = await this.deps.repo.listMachines(orgId);
    const machines = rows.map(machineChoice);
    const addsMib = rolesPlannedMib(recipe);
    const machineId = chosen ?? (rows.length === 1 ? rows[0]!.id : null);
    if (machineId === null) {
      const finding: RecipeFinding = {
        code: "machine.required",
        severity: "error",
        path: "machine_id",
        message: "choose the machine the roles go on",
      };
      return { machines, machineId, addsMib, findings: [finding] };
    }
    const machine = rows.find((item) => item.id === machineId);
    if (!machine) {
      throw new RecipeError("machine not found", 404);
    }
    const { limits } = await this.policy.standing(orgId);
    const visible = user ? await visibleGuildIds(this.deps.repo, orgId, String(user.id)) : null;
    const findings = machineFindings(recipe, machine, {
      maxAgents: Math.min(limits.maxAgentsPerMachine ?? MAX_AGENTS_PER_MACHINE, MAX_AGENTS_PER_MACHINE),
      private: visible !== null && !hostsOnlyVisible(machine, visible),
    });
    return { machines, machineId, addsMib, findings };
  }

  async createSkeleton(
    org: Record<string, unknown>,
    user: Record<string, unknown>,
    recipeRow: Record<string, unknown>,
    choices: ApplyChoices = {},
  ): Promise<Record<string, unknown>> {
    const preview = await this.preview(org, recipeRow, choices, user);
    if (String(recipeRow.status) !== "ready") {
      throw new RecipeError("recipe is not approved");
    }
    if ((preview.errors as unknown[]).length) {
      throw new RecipeError(
        `recipe has blocking validation errors: ${(preview.errors as Array<{ message?: string }>)
          .map((item) => item.message)
          .filter(Boolean)
          .join("; ")}`,
      );
    }
    if ((preview.collisions as string[]).length) {
      throw new RecipeConflictError(`agent names already exist: ${(preview.collisions as string[]).join(", ")}`);
    }
    const roleModels = preview.models as RoleModel[];
    const unchosen = roleModels.filter((item) => !item.model).map((item) => item.role);
    if (unchosen.length) {
      throw new RecipeError(`choose a model for ${unchosen.join(", ")}`);
    }
    const ctx = await this.validationContext(String(org.id));
    const recipe = prepareRecipeForApply(parseRecipe(recipeRow.body), ctx.publishedServers, roleModelMap(roleModels));
    const machineId = String(preview.machine_id);
    const maxAgentsPerMachine = await assertCanPlaceAgents(
      this.policy,
      this.deps.repo,
      String(org.id),
      machineId,
      recipe.roles.length,
    );
    if (!choices.guild_id) {
      await assertCanCreateGuild(this.policy, this.deps.repo, String(org.id));
    }
    await assertCanCreateAgents(this.policy, this.deps.repo, String(org.id), {
      agents: recipe.roles.length,
      browserAgents: recipe.roles.filter((role) => role.browser.required || role.config.browser).length,
      codingAgents: recipe.roles.filter((role) => role.config.coding === true).length,
    });
    try {
      await assertGuildAgentRoom(this.deps.repo, choices.guild_id || null, recipe.roles.length);
    } catch (error) {
      if (error instanceof GuildAgentLimitError) {
        throw new RecipeConflictError(error.message);
      }
      throw error;
    }
    const applyId = newId("rpl");
    const now = new Date();
    let guildId = choices.guild_id ?? newId("guild");
    let createdGuild = false;
    const createdAgents: string[] = [];
    const createdCollections: string[] = [];
    let applied: Record<string, unknown>;
    const actor = operatorActor({
      orgId: String(org.id),
      actorId: String(user.id),
      actorName: String(user.name ?? "operator"),
      guildId,
    });
    try {
      if (!choices.guild_id) {
        await persistGuild(this.deps.repo, this.deps.notes, {
          guildId,
          name: String(preview.guild_name),
          now,
          orgId: String(org.id),
          orgSlug: String(org.slug),
          about: recipe.guild.about,
          description: recipe.guild.objective,
          groupAgentMessageLimit: recipe.guild.group_agent_message_limit,
          creatorUserId: String(user.id),
        });
        createdGuild = true;
      } else {
        guildId = String(choices.guild_id);
      }
      const names = new Map((preview.names as Array<{ role: string; name: string }>).map((item) => [item.role, item.name]));
      const noteHref = new Map<string, string>();
      for (const note of recipe.notes) {
        if (note.level === "agent") {
          continue;
        }
        const ownerId = note.level === "guild" ? guildId : String(org.id);
        const written = await this.deps.artifacts.writeNote(actor, {
          level: note.level,
          key: note.key,
          content: note.body,
          title: note.key,
        });
        const prefix = ownerPrefix(String(written.org_id ?? org.id), note.level, String(written.owner_id ?? ownerId));
        rememberNoteHref(noteHref, note, `${prefix}${String(written.key ?? note.key)}`);
      }
      const roleToAgent = new Map<string, string>();
      for (const role of recipe.roles) {
        const agentId = newId("a");
        const name = names.get(role.role) ?? role.name_suggestion;
        await persistAgent(this.deps.repo, this.deps.notes, {
          agentId,
          guildId,
          guildName: String(preview.guild_name),
          orgSlug: String(org.slug),
          orgId: String(org.id),
          name,
          config: role.config,
          now,
          focus: role.focus,
          wakeTriggers: role.wake_triggers,
          task: withTrailingNewline(rewriteRolesToNames(roleTaskText(role, recipe), names)),
          avatarShape: role.avatar_shape,
          avatarColor: role.avatar_color,
          artifacts: this.deps.artifacts,
          actor,
          machineId,
          maxAgentsPerMachine,
        });
        createdAgents.push(agentId);
        roleToAgent.set(role.role, agentId);
      }
      for (const note of recipe.notes.filter((item) => item.level === "agent")) {
        const agentId = note.role ? roleToAgent.get(note.role) : createdAgents[0];
        if (!agentId) continue;
        const written = await this.deps.artifacts.writeNote(
          operatorActor({
            orgId: String(org.id),
            actorId: String(user.id),
            actorName: String(user.name ?? "operator"),
            guildId,
            agentId,
          }),
          { level: "agent", key: note.key, content: note.body, title: note.key },
        );
        const prefix = ownerPrefix(String(written.org_id ?? org.id), "agent", agentId);
        rememberNoteHref(noteHref, note, `${prefix}${String(written.key ?? note.key)}`);
      }
      const roleToName = names;
      for (const role of recipe.roles) {
        const agentId = roleToAgent.get(role.role);
        if (!agentId) continue;
        let task = withTrailingNewline(rewriteRolesToNames(roleTaskText(role, recipe), roleToName));
        const rewritten = rewriteRecipeEmbedsToDisplayPaths(task, noteHref);
        if (rewritten.unresolved.length) {
          throw new RecipeError(
            `${role.role} standing prompt has unresolved file links: ${rewritten.unresolved.join(", ")}`,
          );
        }
        task = rewritten.text;
        if (task.trim()) {
          await this.deps.repo.writeAgentTask(
            operatorActor({
              orgId: String(org.id),
              actorId: String(user.id),
              actorName: String(user.name ?? "operator"),
              guildId,
              agentId,
            }),
            agentId,
            task,
          );
        }
        const scriptLimit = maxScriptsOf(role.config);
        if (role.scripts.length > scriptLimit) {
          throw new RecipeError(
            `${role.role} has ${role.scripts.length} scripts; max_scripts is ${scriptLimit}`,
          );
        }
        for (const script of role.scripts) {
          await this.deps.scripts.create(
            operatorActor({
              orgId: String(org.id),
              actorId: String(user.id),
              actorName: String(user.name ?? "operator"),
              guildId,
              agentId,
            }),
            agentId,
            script.name,
            script.description,
            script.source,
            script.parameters,
            { maxScripts: scriptLimit },
          );
        }
        for (const schedule of schedulesForRole(role, recipe)) {
          await this.deps.schedules.create(
            agentId,
            { cron: schedule.cron, window: schedule.window },
            schedule.description,
            clippedInstruction(
              rewriteRolesToNames(schedule.instruction || roleTaskText(role, recipe), roleToName),
            ),
            { paused: true },
          );
        }
        await this.writeNativeAccess(role, agentId, now);
      }
      const collections = (preview.collections as CollectionPlan[]).map((item) => ({ ...item }));
      for (const item of collections) {
        if (item.action === "create") {
          let created: CollectionView;
          try {
            created = await this.deps.artifacts.createCollection(actor, {
              name: item.name,
              purpose: item.purpose,
              columns: item.columns,
              ...(item.scope === "guild" ? { guildId } : {}),
            });
          } catch (error) {
            if (error instanceof ArtifactError && error.status === 409) {
              throw new RecipeConflictError(
                `collection ${item.name} was created in the organisation while applying; preview again`,
              );
            }
            throw error;
          }
          createdCollections.push(created.id);
          item.collection_id = created.id;
        }
        if (!item.collection_id || item.scope === "guild") {
          // A guild's own table is written by every member and takes no grant.
          continue;
        }
        await this.deps.artifacts.setAccess(actor, {
          collectionId: item.collection_id,
          subjectType: "guild",
          subjectId: guildId,
          mode: item.guild,
        });
        for (const writer of item.writers) {
          const agentId = roleToAgent.get(writer);
          if (!agentId) continue;
          await this.deps.artifacts.setAccess(actor, {
            collectionId: item.collection_id,
            subjectType: "agent",
            subjectId: agentId,
            mode: "write",
          });
        }
      }
      const planNames = [...names.entries()].map(([role, name]) => ({
        role,
        name,
        agent_id: roleToAgent.get(role),
      }));
      const connections = ((preview.connections as Array<Record<string, unknown>>) ?? []).map((item) => ({ ...item }));
      for (const connection of connections) {
        const connectionId = typeof connection.connection_id === "string" ? connection.connection_id : "";
        if (connection.action === "reuse" && connectionId) {
          await this.writeOverlays(
            {
              recipe_id: recipeRow.id,
              org_id: org.id,
              guild_id: guildId,
              plan: { names: planNames },
            },
            String(connection.server),
            connectionId,
          );
          connection.bound = true;
        }
      }
      const plan = {
        names: planNames,
        connections,
        secrets: preview.secrets,
        collections: collections.map((item) => ({
          name: item.name,
          action: item.action,
          collection_id: item.collection_id,
          guild: item.guild,
          writers: item.writers,
        })),
        activate_keys:
          choices.activate_keys ??
          recipe.roles.flatMap((role) => schedulesForRole(role, recipe).map((item) => item.key)),
      };
      const checklist = checklistFromPlan(recipe, plan as Record<string, unknown>);
      const result = await this.deps.repo.pool.query(
        `INSERT INTO recipe_applies (
           id, org_id, recipe_id, created_by_user_id, guild_id, created_guild, status,
           recipe_body_version, preview, plan, checklist, warnings, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,'checklist',$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$12)
         RETURNING *`,
        [
          applyId,
          org.id,
          recipeRow.id,
          user.id,
          guildId,
          createdGuild,
          recipeRow.body_version,
          JSON.stringify(preview),
          JSON.stringify(plan),
          JSON.stringify(checklist),
          JSON.stringify((preview.findings as unknown[]) ?? []),
          now.toISOString(),
        ],
      );
      applied = mapApply(result.rows[0] as Record<string, unknown>);
    } catch (error) {
      for (const agentId of createdAgents.reverse()) {
        await this.deps.repo.deleteAgent(agentId).catch(() => undefined);
      }
      if (createdGuild) {
        await this.deps.repo.deleteGuild(guildId).catch(() => undefined);
      }
      for (const collectionId of createdCollections.reverse()) {
        await this.deps.artifacts.deleteCollection(actor, collectionId).catch(() => undefined);
      }
      throw error;
    }
    // Granted once the apply stands: a rolled-back guild would take a secret whose only grant it held.
    return this.grantReusedSecrets(applied, user);
  }

  async get(applyId: string): Promise<Record<string, unknown> | null> {
    const result = await this.deps.repo.pool.query(`SELECT * FROM recipe_applies WHERE id = $1`, [applyId]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? mapApply(row) : null;
  }

  async listOpenForGuild(guildId: string): Promise<Record<string, unknown> | null> {
    const result = await this.deps.repo.pool.query(
      `SELECT * FROM recipe_applies
        WHERE guild_id = $1 AND status IN ('skeleton', 'checklist')
        ORDER BY updated_at DESC LIMIT 1`,
      [guildId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? mapApply(row) : null;
  }

  async listReadyForGuild(guildId: string): Promise<Record<string, unknown> | null> {
    const result = await this.deps.repo.pool.query(
      `SELECT * FROM recipe_applies
        WHERE guild_id = $1 AND status = 'ready'
        ORDER BY updated_at DESC LIMIT 1`,
      [guildId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? mapApply(row) : null;
  }

  /** The open checklist, and agents whose recipe login was deferred until after activate. */
  async guildApplyState(guildId: string): Promise<{
    apply: Record<string, unknown> | null;
    browser_logins: string[];
  }> {
    const open = await this.listOpenForGuild(guildId);
    if (open) return { apply: open, browser_logins: [] };
    return { apply: null, browser_logins: browserLoginAgentIds(await this.listReadyForGuild(guildId)) };
  }

  async verifyStep(applyRow: Record<string, unknown>, stepId: string): Promise<Record<string, unknown>> {
    const checklist = [...((applyRow.checklist as Array<Record<string, unknown>>) ?? [])];
    const step = checklist.find((item) => item.id === stepId);
    if (!step) {
      throw new RecipeError("step not found", 404);
    }
    if (step.closure !== "verified") {
      throw new RecipeError("step is attestation-only");
    }
    const checked = await this.machineCheck({ ...applyRow, checklist }, step);
    if (!checked.ok) {
      throw new RecipeError(checked.reason);
    }
    step.status = "verified";
    step.closed_at = new Date().toISOString();
    return this.saveChecklist(String(applyRow.id), checklist, applyRow);
  }

  async confirmStep(
    applyRow: Record<string, unknown>,
    stepId: string,
    options: { later?: boolean; skip?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const checklist = [...((applyRow.checklist as Array<Record<string, unknown>>) ?? [])];
    if (options.skip) {
      const skipped = skipApplyChecklistStep(checklist, stepId);
      const warnings = [...((applyRow.warnings as unknown[]) ?? []), skipped.warning];
      return this.saveChecklist(String(applyRow.id), skipped.checklist, applyRow, warnings);
    }
    const step = checklist.find((item) => item.id === stepId);
    if (!step) {
      throw new RecipeError("step not found", 404);
    }
    if (step.closure !== "confirmed") {
      throw new RecipeError("step must be verified by the server");
    }
    step.status = "confirmed";
    step.closed_at = new Date().toISOString();
    if (step.kind === "browser") {
      step.resolution = options.later ? "later" : "done";
    }
    return this.saveChecklist(String(applyRow.id), checklist, applyRow);
  }

  async activate(applyRow: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const checklist = deferLaunchSteps(
      (applyRow.checklist as Array<Record<string, unknown>>) ?? [],
      now,
    );
    const open = blockingApplySteps(checklist);
    if (open.length) {
      throw new RecipeError(`checklist still open: ${open.map((item) => item.id).join(", ")}`);
    }
    const plan = (applyRow.plan ?? {}) as Record<string, unknown>;
    const names = (plan.names as Array<{ role: string; agent_id?: string }>) ?? [];
    const ctx = await this.validationContext(String(applyRow.org_id));
    const recipe = prepareRecipeForApply(parseRecipe((await this.deps.recipes.get(String(applyRow.recipe_id)))?.body), ctx.publishedServers);
    const activate = new Set((plan.activate_keys as string[]) ?? []);
    for (const role of recipe.roles) {
      const agentId = names.find((item) => item.role === role.role)?.agent_id;
      if (!agentId) continue;
      const rows = await this.deps.repo.listSchedules(agentId);
      const created = schedulesForRole(role, recipe);
      for (const [index, row] of rows.entries()) {
        const key = created[index]?.key;
        if (key && activate.has(key)) {
          await this.deps.schedules.setPaused(agentId, String(row.id), false);
        }
      }
    }
    await this.deps.repo.pool.query(
      `UPDATE recipe_applies SET status = 'ready', checklist = $2::jsonb, updated_at = $3 WHERE id = $1`,
      [applyRow.id, JSON.stringify(checklist), now.toISOString()],
    );
    return { ...(await this.get(String(applyRow.id))), status: "ready" };
  }

  async abort(applyRow: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (applyRow.status === "ready") {
      throw new RecipeError("completed apply cannot be aborted");
    }
    if (applyRow.created_guild && applyRow.guild_id) {
      const members = await this.deps.repo.listAgents(String(applyRow.guild_id));
      for (const member of members) {
        await this.deps.repo.deleteAgent(String(member.id)).catch(() => undefined);
      }
      await this.deps.repo.deleteGuild(String(applyRow.guild_id)).catch(() => undefined);
      const plan = (applyRow.plan ?? {}) as Record<string, unknown>;
      const actor = operatorActor({
        orgId: String(applyRow.org_id),
        actorId: String(applyRow.created_by_user_id ?? applyRow.org_id),
        actorName: "operator",
      });
      for (const item of (plan.collections as Array<Record<string, unknown>>) ?? []) {
        if (item.action === "create" && typeof item.collection_id === "string") {
          await this.deps.artifacts.deleteCollection(actor, item.collection_id).catch(() => undefined);
        }
      }
    }
    await this.deps.repo.pool.query(
      `UPDATE recipe_applies SET status = 'aborted', updated_at = $2 WHERE id = $1`,
      [applyRow.id, new Date().toISOString()],
    );
    return { ...(await this.get(String(applyRow.id))), status: "aborted" };
  }

  async writeOverlays(applyRow: Record<string, unknown>, server: string, connectionId: string): Promise<void> {
    const ctx = await this.validationContext(String(applyRow.org_id));
    const recipe = prepareRecipeForApply(parseRecipe((await this.deps.recipes.get(String(applyRow.recipe_id)))?.body), ctx.publishedServers);
    const connection = recipe.connections.find((item) => item.server === server);
    if (!connection) return;
    const serverRow = await this.deps.repo.getMcpServerBySlug(server, String(applyRow.org_id));
    if (!serverRow) return;
    const plan = (applyRow.plan ?? {}) as Record<string, unknown>;
    const names = (plan.names as Array<{ role: string; agent_id?: string }>) ?? [];
    const now = new Date();
    const listed = await this.deps.repo.listMcpTools(connectionId);
    const known = new Set(listed.map((row) => String(row.namespaced_name)));
    const roleSpecs = recipe.roles.map((role) => ({
      role: role.role,
      spec: connection.roles[role.role],
    }));
    const enabledRoles = roleSpecs.filter((item) => item.spec?.enabled);
    const allRolesEnabled = roleSpecs.length > 0 && roleSpecs.every((item) => item.spec?.enabled === true);
    const toolsUniform =
      allRolesEnabled &&
      enabledRoles.every(
        (item) => JSON.stringify(item.spec?.tools ?? {}) === JSON.stringify(enabledRoles[0]?.spec?.tools ?? {}),
      );
    const bindAtGuild = connection.recommended_scope !== "agent" && allRolesEnabled && toolsUniform;

    const bind = async (scope: "guild" | "agent", scopeId: string, spec: { enabled: boolean; tools: Record<string, boolean> }) => {
      await this.deps.repo.upsertBinding(
        newId("bind"),
        "mcp",
        String(serverRow.id),
        scope,
        scopeId,
        spec.enabled,
        connectionId,
        now,
      );
      for (const [tool, enabled] of Object.entries(spec.tools)) {
        if (!known.has(tool)) {
          continue;
        }
        await this.deps.repo.upsertBinding(newId("bind"), "mcp_tool", tool, scope, scopeId, enabled, null, now);
      }
    };

    if (bindAtGuild) {
      const spec = enabledRoles[0]?.spec;
      if (!spec) return;
      await bind("guild", String(applyRow.guild_id), spec);
      return;
    }

    for (const item of enabledRoles) {
      const agentId = names.find((row) => row.role === item.role)?.agent_id;
      if (!agentId || !item.spec) continue;
      await bind("agent", agentId, item.spec);
    }
  }

  /** The operator actor a preview lists with; a preview only reads. */
  private operator(org: Record<string, unknown>, user?: Record<string, unknown>): ArtifactActor {
    return operatorActor({
      orgId: String(org.id),
      actorId: String(user?.id ?? org.id),
      actorName: String(user?.name ?? "operator"),
    });
  }

  /**
   * Matches each recipe collection against the organisation's live tables: a
   * free name is created, a table whose columns accept every recipe column is
   * reused, and anything else is a conflict the operator resolves by renaming.
   */
  private async planCollections(
    org: Record<string, unknown>,
    recipe: RecipeDocument,
    user?: Record<string, unknown>,
  ): Promise<CollectionPlan[]> {
    if (!recipe.collections.length) {
      return [];
    }
    const live = await this.deps.artifacts.listCollections(this.operator(org, user));
    const byName = new Map(live.map((item) => [item.name, item]));
    return recipe.collections.map((collection) => {
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
          differences: [`the organisation already has a database called ${collection.name}`],
        };
      }
      const differences = columnDifferences(collection.columns, existing.columns);
      return {
        ...collection,
        action: differences.length ? "conflict" : "reuse",
        collection_id: existing.id,
        differences,
      };
    });
  }

  private resolveNames(recipe: RecipeDocument, decisions: NameDecision[]): Map<string, string> {
    const names = new Map<string, string>();
    const chosen = new Map(decisions.map((item) => [item.role, item.name]));
    for (const role of recipe.roles) {
      const name = validateAgentName(chosen.get(role.role) || role.name_suggestion);
      names.set(role.role, name);
    }
    return names;
  }

  private async planConnections(
    org: Record<string, unknown>,
    recipe: RecipeDocument,
    decisions: ConnectionDecision[],
  ): Promise<Array<Record<string, unknown>>> {
    const connections = await this.deps.repo.listMcpConnections({ orgId: String(org.id) });
    const servers = await this.deps.repo.listMcpServers(String(org.id));
    const bySlug = new Map(servers.map((row) => [String(row.slug), row]));
    const chosen = new Map(decisions.map((item) => [item.server, item]));
    return recipe.connections.map((connection) => {
      const server = bySlug.get(connection.server);
      const reusable = connections.filter(
        (row) =>
          String(row.mcp_server_id) === String(server?.id) &&
          (row.owner_scope === "org" || row.owner_scope === "platform") &&
          row.status === "connected",
      );
      const decision = chosen.get(connection.server);
      return {
        server: connection.server,
        auth: connection.auth,
        recommended_scope: connection.recommended_scope === "org" ? "guild" : connection.recommended_scope,
        reusable: reusable.map((row) => ({
          id: row.id,
          owner_scope: row.owner_scope,
          status: row.status,
        })),
        action: decision?.action ?? (reusable.length ? "reuse" : "create"),
        connection_id: decision?.connection_id ?? (reusable[0] ? String(reusable[0].id) : null),
        setup: connection.setup,
        resources: connection.resources ?? [],
      };
    });
  }

  /** A recipe secret collides when its name is taken in the organisation; reuse is then the default. */
  private async planSecrets(
    org: Record<string, unknown>,
    recipe: RecipeDocument,
    decisions: SecretDecision[],
  ): Promise<Array<Record<string, unknown>>> {
    const existing = await this.deps.repo.listSecrets(String(org.id));
    const names = new Set(existing.map((row) => String(row.name)));
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

  private async machineCheck(applyRow: Record<string, unknown>, step: Record<string, unknown>): Promise<{ ok: boolean; reason: string }> {
    const id = String(step.id);
    if (id.startsWith("conn:")) {
      const slug = id.slice(5);
      const access = await httpAccess(this.deps.repo, {
        orgId: String(applyRow.org_id),
        guildId: String(applyRow.guild_id),
        viewScope: "guild",
      });
      const mcp = ((access.mcp as Array<Record<string, unknown>>) ?? []).find((item) => item.slug === slug);
      const connected = mcp?.status === "connected";
      if (connected && typeof mcp?.connection_id === "string" && mcp.connection_id) {
        await this.writeOverlays(applyRow, slug, mcp.connection_id);
        const overlays = ((applyRow.checklist as Array<Record<string, unknown>>) ?? []).find(
          (item) => item.id === `overlays:${slug}`,
        );
        if (overlays && overlays.status === "open") {
          overlays.status = "verified";
          overlays.closed_at = new Date().toISOString();
        }
      }
      return connected
        ? { ok: true, reason: "" }
        : {
            ok: false,
            reason: `${slug} is not connected yet. Connect it on this step, then check it.`,
          };
    }
    if (id.startsWith("repo:")) {
      const name = id.slice(5);
      const listed = await this.deps.repo.listGuildRepositories(String(applyRow.guild_id));
      return listed.some((row) => row.name === name)
        ? { ok: true, reason: "" }
        : { ok: false, reason: `The guild has no repository named ${name} yet. Add it in the guild's Settings, then check it.` };
    }
    if (id.startsWith("secret:")) {
      const secret = planSecret(applyRow, id.slice(7));
      const name = String(secret?.dest_name ?? id.slice(7));
      const missing = await this.rolesWithoutSecret(applyRow, name, (secret?.roles as string[] | undefined) ?? []);
      return missing.length
        ? {
            ok: false,
            reason: `Secret ${name} does not reach ${missing.join(", ")} yet. Add or grant it under Secrets, then check this step.`,
          }
        : { ok: true, reason: "" };
    }
    if (id.startsWith("overlays:")) {
      const slug = id.slice(9);
      const server = await this.deps.repo.getMcpServerBySlug(slug, String(applyRow.org_id));
      if (!server) {
        return { ok: false, reason: `${slug} is not in the catalog.` };
      }
      const bindings = await this.deps.repo.listBindingsCovering({
        orgId: String(applyRow.org_id),
        guildId: String(applyRow.guild_id),
      });
      const bound = bindings.some(
        (row) =>
          row.catalog_kind === "mcp" &&
          String(row.catalog_id) === String(server.id) &&
          (row.scope === "guild" || row.scope === "agent"),
      );
      return bound
        ? { ok: true, reason: "" }
        : {
            ok: false,
            reason: `${slug} tools are not bound yet. Connect ${slug} on the Connect step first.`,
          };
    }
    return { ok: false, reason: "this step cannot be checked yet" };
  }

  /** Planned roles (the secret's roles, or every role) whose agent does not get the secret. */
  private async rolesWithoutSecret(
    applyRow: Record<string, unknown>,
    name: string,
    roles: string[],
  ): Promise<string[]> {
    const planned = ((jsonObj(applyRow.plan) as Record<string, unknown> | null)?.names ?? []) as Array<
      Record<string, unknown>
    >;
    const missing: string[] = [];
    for (const item of planned) {
      if (roles.length && !roles.includes(String(item.role))) continue;
      if (typeof item.agent_id !== "string") continue;
      const environment = await this.deps.repo.listAgentSecrets({
        orgId: String(applyRow.org_id),
        guildId: String(applyRow.guild_id),
        agentId: item.agent_id,
      });
      if (!environment.some((row) => String(row.name) === name)) {
        missing.push(String(item.name ?? item.role));
      }
    }
    return missing;
  }

  /**
   * Reused secrets that do not reach the new guild are granted to it when the applying
   * user is an org owner or admin; secret steps that now pass close.
   */
  private async grantReusedSecrets(
    applyRow: Record<string, unknown>,
    user: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const orgId = String(applyRow.org_id);
    const guildId = String(applyRow.guild_id);
    const membership = await this.deps.repo.getMembership(orgId, String(user.id));
    const plan = (jsonObj(applyRow.plan) ?? {}) as Record<string, unknown>;
    if (membership && managesOrgSecrets(String(membership.role))) {
      for (const secret of (plan.secrets as Array<Record<string, unknown>>) ?? []) {
        if (secret.action !== "reuse") continue;
        const row = await this.deps.repo.getSecretByName(orgId, String(secret.dest_name ?? secret.name));
        if (!row || row.org_wide) continue;
        const access = accessOf(row);
        if (access.guild_ids.includes(guildId)) continue;
        await this.deps.repo.setSecretAccess(
          String(row.id),
          { ...access, guild_ids: [...access.guild_ids, guildId] },
          new Date(),
        );
      }
    }
    const checklist = [...((applyRow.checklist as Array<Record<string, unknown>>) ?? [])];
    let closed = false;
    for (const step of checklist) {
      if (step.kind !== "secret" || step.status !== "open") continue;
      if ((await this.machineCheck(applyRow, step)).ok) {
        step.status = "verified";
        step.closed_at = new Date().toISOString();
        closed = true;
      }
    }
    return closed ? this.saveChecklist(String(applyRow.id), checklist, applyRow) : applyRow;
  }

  private async saveChecklist(
    applyId: string,
    checklist: Array<Record<string, unknown>>,
    applyRow: Record<string, unknown>,
    warnings?: unknown,
  ): Promise<Record<string, unknown>> {
    const nextWarnings = warnings ?? applyRow.warnings ?? [];
    await this.deps.repo.pool.query(
      `UPDATE recipe_applies SET checklist = $2::jsonb, warnings = $3::jsonb, updated_at = $4 WHERE id = $1`,
      [applyId, JSON.stringify(checklist), JSON.stringify(nextWarnings), new Date().toISOString()],
    );
    return { ...applyRow, checklist, warnings: nextWarnings };
  }

  private async writeNativeAccess(role: RecipeRole, agentId: string, now: Date): Promise<void> {
    for (const [tool, enabled] of Object.entries(role.native_tools)) {
      await this.deps.repo.upsertBinding(newId("bind"), "native_tool", tool, "agent", agentId, enabled, null, now);
    }
    for (const [grant, enabled] of Object.entries(role.grants)) {
      await this.deps.repo.upsertBinding(newId("bind"), "artifact_grant", grant, "agent", agentId, enabled, null, now);
    }
  }
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
    if (column.values && match.values) {
      const accepted = match.values;
      const rejected = column.values.filter((value) => !accepted.includes(value));
      if (rejected.length) {
        differences.push(`${column.name} does not accept ${rejected.join(", ")}`);
      }
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

export function browserLoginSetup(role: RecipeRole, site?: string): string {
  const written = role.browser.instructions.trim();
  if (written) return written;
  const target = site || "the site";
  return `This role has no native connector. After apply, open the agent and take control of its Chromium to log into ${target}. Session cookies stay in the browser profile. Mark the reminder as done once you have — we cannot tell when you are finished.`;
}

/** The plan's entry for a recipe secret, by its recipe name. */
function planSecret(applyRow: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const plan = (jsonObj(applyRow.plan) ?? {}) as Record<string, unknown>;
  return ((plan.secrets as Array<Record<string, unknown>>) ?? []).find((item) => item.name === name);
}

export function checklistFromPlan(recipe: RecipeDocument, plan: Record<string, unknown>): Array<Record<string, unknown>> {
  const steps: Array<Record<string, unknown>> = [];
  for (const connection of (plan.connections as Array<Record<string, unknown>>) ?? []) {
    const bound = connection.bound === true || (connection.action === "reuse" && connection.connection_id);
    steps.push({
      id: `conn:${connection.server}`,
      kind: "connection",
      title: `Connect ${connection.server}`,
      setup: connection.setup,
      closure: "verified",
      status: bound ? "verified" : "open",
    });
    steps.push({
      id: `overlays:${connection.server}`,
      kind: "overlays",
      title: `Tool overlays for ${connection.server}`,
      closure: "verified",
      status: bound ? "verified" : "open",
    });
  }
  const planned = new Set(steps.map((step) => String(step.id)));
  if (recipe.repositories.length && !planned.has(`conn:${GITHUB_SLUG}`)) {
    steps.push({
      id: `conn:${GITHUB_SLUG}`,
      kind: "connection",
      title: "Connect GitHub",
      setup:
        "Install the GitHub App on the account that owns the repositories (once per account; later logins reuse that install), so the coding agents clone, push, and open pull requests. Public repositories clone without it; pushing to them still needs it. On the GitHub card in Tools, pick this guild's or agent's repositories. In the guild's Settings, set Commit author email to a verified email on the GitHub account that owns any deploy project (Vercel, etc.).",
      closure: "verified",
      status: "open",
    });
  }
  for (const repository of recipe.repositories) {
    steps.push({
      id: `repo:${repository.name}`,
      kind: "repository",
      title: `Add the ${repository.name} repository`,
      setup: `${repository.purpose ? `${repository.purpose} ` : ""}Add it in the guild's Settings under Repositories, named ${repository.name}.`,
      closure: "verified",
      status: "open",
    });
  }
  for (const secret of (plan.secrets as Array<Record<string, unknown>>) ?? []) {
    if (secret.action === "skip") continue;
    steps.push({
      id: `secret:${secret.name}`,
      kind: "secret",
      title: `Secret ${secret.dest_name ?? secret.name}`,
      closure: "verified",
      status: "open",
    });
  }
  for (const role of recipe.roles) {
    if (!(role.browser.required || role.config.browser)) continue;
    const site = recipe.design.browser.find((item) => item.role === role.role)?.site;
    const target = site || "the web page";
    steps.push({
      id: `browser:${role.role}`,
      kind: "browser",
      title: `Take control and log into ${target}`,
      setup: browserLoginSetup(role, site),
      site: site || "",
      role: role.role,
      deferrable: true,
      phase: "post_apply",
      closure: "confirmed",
      status: "open",
    });
  }
  for (const [index, card] of recipe.external.entries()) {
    steps.push({
      id: `external:${index}`,
      kind: "external",
      title: card.title,
      setup: card.setup,
      closure: "confirmed",
      status: "open",
    });
  }
  steps.push({
    id: "activate",
    kind: "activate",
    title: "Activate paused routines",
    closure: "confirmed",
    status: "open",
  });
  return steps;
}

export function isSkippableApplyStep(step: Record<string, unknown>): boolean {
  if (step.status !== "open") return false;
  return (
    step.kind === "connection" || step.kind === "secret" || step.kind === "overlays" || step.kind === "repository"
  );
}

export function blockingApplySteps(checklist: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return checklist.filter((item) => item.status === "open" && item.kind !== "browser" && item.kind !== "activate");
}

function closeAsSkipped(step: Record<string, unknown>, now: Date): void {
  step.status = "skipped";
  step.resolution = "skipped";
  step.closed_at = now.toISOString();
}

export function skipApplyChecklistStep(
  checklist: Array<Record<string, unknown>>,
  stepId: string,
  now = new Date(),
): { checklist: Array<Record<string, unknown>>; warning: Record<string, unknown> } {
  const next = checklist.map((item) => ({ ...item }));
  const step = next.find((item) => item.id === stepId);
  if (!step) {
    throw new RecipeError("step not found", 404);
  }
  if (!isSkippableApplyStep(step)) {
    throw new RecipeError("this step cannot be skipped");
  }
  closeAsSkipped(step, now);
  if (step.kind === "connection") {
    const slug = String(step.id).slice("conn:".length);
    const overlays = next.find((item) => item.id === `overlays:${slug}`);
    if (overlays && overlays.status === "open") {
      closeAsSkipped(overlays, now);
    }
  }
  const title = String(step.title || step.id);
  return {
    checklist: next,
    warning: {
      code: "step.skipped",
      path: String(step.id),
      message: `Skipped ${title}. Agents will not have this access until you connect it later from Tools.`,
    },
  };
}

/** Agents a ready apply still asks to log in by hand (`resolution: later` after activate). */
export function browserLoginAgentIds(applyRow: Record<string, unknown> | null | undefined): string[] {
  if (!applyRow || applyRow.status !== "ready") return [];
  const plan = (jsonObj(applyRow.plan) ?? applyRow.plan ?? {}) as Record<string, unknown>;
  const names = (Array.isArray(plan.names) ? plan.names : []) as Array<Record<string, unknown>>;
  const checklist = Array.isArray(applyRow.checklist)
    ? applyRow.checklist
    : ((jsonObj(applyRow.checklist) as unknown[]) ?? []);
  const roles = new Set(
    (checklist as Array<Record<string, unknown>>)
      .filter((item) => item.kind === "browser" && item.resolution === "later")
      .map((item) => String(item.role ?? "")),
  );
  return names
    .filter((item) => typeof item.agent_id === "string" && roles.has(String(item.role)))
    .map((item) => String(item.agent_id));
}

export function deferLaunchSteps(
  checklist: Array<Record<string, unknown>>,
  now = new Date(),
): Array<Record<string, unknown>> {
  return checklist.map((item) => {
    if (item.kind === "browser" && item.status === "open") {
      return {
        ...item,
        status: "confirmed",
        resolution: "later",
        closed_at: now.toISOString(),
      };
    }
    if (item.kind === "activate" && item.status === "open") {
      return {
        ...item,
        status: "confirmed",
        resolution: "activated",
        closed_at: now.toISOString(),
      };
    }
    return { ...item };
  });
}

function clippedInstruction(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= INSTRUCTION_MAX) return trimmed;
  return trimmed.slice(0, INSTRUCTION_MAX);
}

function withTrailingNewline(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
}

function rememberNoteHref(
  noteHref: Map<string, string>,
  note: RecipeDocument["notes"][number],
  displayPath: string,
): void {
  noteHref.set(note.id, displayPath);
  noteHref.set(`recipe:${note.id}`, displayPath);
  noteHref.set(recipeNotePath(note), displayPath);
}

function roleTaskText(role: RecipeRole, recipe: RecipeDocument): string {
  const body = role.task.body.trim();
  if (body) return body;
  return [role.focus.trim(), recipe.guild.objective.trim(), recipe.guild.about.trim()].filter(Boolean).join("\n\n");
}

function validCron(value: string): boolean {
  try {
    validateCron(value);
    return true;
  } catch {
    return false;
  }
}

function schedulesForRole(role: RecipeRole, recipe: RecipeDocument): RecipeSchedule[] {
  if (role.schedules.length) return role.schedules;
  return recipe.design.routines
    .filter((item) => item.role === role.role && validCron(item.cadence))
    .map((item) => ({
      key: item.key,
      cron: item.cadence,
      description: item.key,
      instruction: clippedInstruction(roleTaskText(role, recipe)),
      author: builderAuthor(),
    }));
}

/** The models the preview resolved, by role. */
function roleModelMap(models: RoleModel[]): Map<string, string> {
  return new Map(models.flatMap((item) => (item.model ? [[item.role, item.model] as const] : [])));
}

/**
 * The agent config a role applies as: the role's, with the model the operator chose (else the
 * recipe's recommendation), and the browser and coding flags settled. The machine the agent goes
 * on is the apply's.
 */
export function configFromRecipeRole(role: RecipeRole, model?: string): Record<string, unknown> {
  const roleConfig = { ...role.config };
  const recommended = typeof roleConfig.model === "string" ? roleConfig.model.trim() : "";
  const chosen = model ?? recommended;
  return addMissingFlags(
    addMissingCliScriptingAndMemory(
      addMissingThinkingLevel(
        addMissingBrowserLanguage(
          addMissingRunLimits(
            addMissingTemperatureAndStepLimits({
              ...roleConfig,
              model: chosen,
              browser: Boolean(role.browser.required || roleConfig.browser),
              coding: roleConfig.coding === true,
            }),
          ),
        ),
      ),
    ),
  );
}

export function prepareRecipeForApply(
  recipe: RecipeDocument,
  publishedServers?: Set<string>,
  models?: Map<string, string>,
): RecipeDocument {
  void publishedServers;
  for (const role of recipe.roles) {
    role.config = configFromRecipeRole(role, models?.get(role.role));
    if (!role.task.body.trim()) {
      role.task.body = roleTaskText(role, recipe);
    }
    if (!role.schedules.length) {
      role.schedules = schedulesForRole(role, recipe);
    }
  }
  return recipe;
}

function inventoryFromRecipe(
  recipe: RecipeDocument,
  names: Map<string, string>,
  connections: Array<Record<string, unknown>>,
  secrets: Array<Record<string, unknown>>,
  collections: CollectionPlan[],
  guildName: string,
): Record<string, unknown> {
  return {
    guild: {
      name: guildName,
      about: recipe.guild.about,
      objective: recipe.guild.objective,
    },
    agents: recipe.roles.map((role) => ({
      role: role.role,
      name: names.get(role.role) ?? role.name_suggestion,
      focus: role.focus,
      model: role.config.model ?? "",
      browser: Boolean(role.browser.required || role.config.browser),
      coding: role.config.coding === true,
      task: roleTaskText(role, recipe),
      native_tools: Object.entries(role.native_tools)
        .filter(([, enabled]) => enabled)
        .map(([name]) => name),
    })),
    collections,
    notes: recipe.notes.map((item) => ({
      key: item.key,
      level: item.level,
      role: item.role ?? null,
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
    connections,
    secrets,
    repositories: recipe.repositories,
  };
}