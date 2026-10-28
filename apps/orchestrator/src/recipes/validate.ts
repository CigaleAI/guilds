import {
  HARNESSES,
  EFFORTS,
  type RecipeFinding,
  type RecipeDocument,
  type RecipeRole,
} from "../db/schema/index.js";
import { parseModelId, providerLabel } from "../llm/providers.js";
import { CONFIG_KEYS, isValidSecretAliases } from "../agents/config.js";
import { credentialFix, HARNESS_INFO, harnessModelOf, isHarness, isHarnessOff } from "../coding/harnesses.js";
import { harnessEffortsFor, isEffort } from "../coding/harness-models.js";
import { validateTiming } from "../schedules/timing.js";
import { validateScriptName, validateScriptDescription, validateScriptSource, validateScriptParameters } from "../scripts/validation.js";
import { NATIVE_TOOLS } from "../seed/catalog.js";
import { collectTaskEmbeds } from "../artifacts/embeds.js";
import { isDisplayPath } from "../artifacts/paths.js";
import { operatorAccessCuts } from "./access-edits.js";
import { collectRecipeNotePaths, recipeNotePath } from "./rewrite.js";
import { browserRoles, finding, type RecipeRule, type ValidationContext } from "./findings.js";
import { validateDesign } from "./validate-design.js";

/** A check of one role of the recipe. */
type RoleRule = (role: RecipeRole, recipe: RecipeDocument, ctx: ValidationContext) => RecipeFinding[];

const NATIVE = new Set<string>(NATIVE_TOOLS);

function codingRoles(recipe: RecipeDocument): RecipeRole[] {
  return recipe.roles.filter((role) => role.config.coding === true);
}

/** A harness the recipe names that apply cannot use, or null. */
function harnessChoiceFinding(role: RecipeRole): RecipeFinding | null {
  const harness = role.config.harness;
  const path = `roles.${role.role}.config.harness`;
  if (harness !== undefined && harness !== null && !isHarness(harness)) {
    return finding("harness.unknown", "warning", path, `unknown harness ${String(harness)}; apply asks for one of ${HARNESSES.join(", ")}`);
  }
  if (isHarness(harness) && role.config.coding !== true) {
    return finding("harness.coding", "warning", path, "config.harness is only for a coding role; apply leaves it out");
  }
  if (isHarness(harness) && isHarnessOff(harness)) {
    return finding("harness.off", "warning", path, `${HARNESS_INFO[harness].label} is turned off on this box; apply asks for another`);
  }
  return null;
}

/** A coding role's harness runs on a credential nobody can know before apply. */
function harnessCredentialFinding(role: RecipeRole): RecipeFinding {
  const harness = role.config.harness;
  const named = isHarness(harness);
  const fix = named ? `after apply, ${credentialFix(harness)}` : "apply asks for its harness";
  return finding(
    "harness.credential",
    "warning",
    `roles.${role.role}.config.harness`,
    `${named ? HARNESS_INFO[harness].label : "the harness"} runs on a subscription credential that is not known before apply; ${fix}`,
  );
}

/** A harness model apply cannot use: not a model name, or on a role without a harness. */
function harnessModelFinding(role: RecipeRole): RecipeFinding | null {
  const model = role.config.harness_model;
  const path = `roles.${role.role}.config.harness_model`;
  if (model === undefined || model === null) {
    return null;
  }
  if (harnessModelOf(role.config) === null) {
    return finding("harness_model.invalid", "warning", path, "config.harness_model is not a model name; apply leaves it out");
  }
  if (!isHarness(role.config.harness)) {
    return finding("harness_model.harness", "warning", path, "config.harness_model needs config.harness; apply leaves it out");
  }
  return null;
}

/** A harness effort apply cannot use: not an effort, on a role without a harness, or not one its model runs at. */
function harnessEffortFinding(role: RecipeRole): RecipeFinding | null {
  const effort = role.config.harness_effort;
  const path = `roles.${role.role}.config.harness_effort`;
  if (effort === undefined || effort === null) {
    return null;
  }
  if (!isEffort(effort)) {
    return finding("harness_effort.invalid", "warning", path, `config.harness_effort is not one of ${EFFORTS.join(", ")}; apply leaves it out`);
  }
  if (!isHarness(role.config.harness)) {
    return finding("harness_effort.harness", "warning", path, "config.harness_effort needs config.harness; apply leaves it out");
  }
  return harnessEffortsFor(role.config.harness, harnessModelOf(role.config)).includes(effort)
    ? null
    : finding("harness_effort.model", "warning", path, "config.harness_model does not run at config.harness_effort; apply leaves it out");
}

/** Secret aliases apply cannot use: not a map of variable names to secret names. */
function secretAliasesFinding(role: RecipeRole): RecipeFinding | null {
  const raw = role.config.secret_aliases;
  if (raw === undefined || raw === null || isValidSecretAliases(raw)) {
    return null;
  }
  return finding(
    "secret_aliases.invalid",
    "warning",
    `roles.${role.role}.config.secret_aliases`,
    "config.secret_aliases is not a map of variable names to secret names; apply leaves it out",
  );
}

function harnessFindings(role: RecipeRole): RecipeFinding[] {
  const choice = harnessChoiceFinding(role);
  const model = harnessModelFinding(role);
  const credential = role.config.coding === true ? harnessCredentialFinding(role) : null;
  return [choice, model, harnessEffortFinding(role), credential, secretAliasesFinding(role)].filter((item): item is RecipeFinding => item !== null);
}

/** More agents than the organisation has room for. */
function agentCapacity(recipe: RecipeDocument, ctx: ValidationContext): RecipeFinding[] {
  if (ctx.remainingAgents === null || recipe.roles.length <= ctx.remainingAgents) return [];
  return [finding("capacity.agents", "error", "roles", `recipe needs ${recipe.roles.length} agents; ${ctx.remainingAgents} remaining`)];
}

/** More browser agents than the organisation has room for. */
function browserCapacity(recipe: RecipeDocument, ctx: ValidationContext): RecipeFinding[] {
  const needed = browserRoles(recipe).length;
  if (ctx.remainingBrowserAgents === null || needed <= ctx.remainingBrowserAgents) return [];
  return [finding("capacity.browser", "error", "roles", `recipe needs ${needed} browser agents; ${ctx.remainingBrowserAgents} remaining`)];
}

/** More coding agents than the organisation has room for. */
function codingCapacity(recipe: RecipeDocument, ctx: ValidationContext): RecipeFinding[] {
  const needed = codingRoles(recipe).length;
  if (ctx.remainingCodingAgents === null || needed <= ctx.remainingCodingAgents) return [];
  return [finding("capacity.coding", "error", "roles", `recipe needs ${needed} coding agents; ${ctx.remainingCodingAgents} remaining`)];
}

/** Repositories no coding role clones. */
function unusedRepositories(recipe: RecipeDocument): RecipeFinding[] {
  if (!recipe.repositories.length || codingRoles(recipe).length) return [];
  return [finding("repositories.unused", "warning", "repositories", "the recipe lists repositories but no role sets config.coding")];
}

/** Config keys an agent does not have. */
function unknownConfigKeys(role: RecipeRole): RecipeFinding[] {
  const unknown = Object.keys(role.config).filter((key) => !CONFIG_KEYS.has(key)).sort();
  return unknown.length ? [finding("config.unknown", "error", `roles.${role.role}.config`, `unknown keys: ${unknown.join(", ")}`)] : [];
}

/** A coding flag that is not a boolean. */
function codingFlag(role: RecipeRole): RecipeFinding[] {
  if (role.config.coding === undefined || typeof role.config.coding === "boolean") return [];
  return [finding("coding.flag", "error", `roles.${role.role}.config.coding`, "config.coding must be a boolean")];
}

/** A model apply cannot create the role with: unknown, for coding agents only, or of a provider the organisation lacks. */
function modelFindings(role: RecipeRole, _recipe: RecipeDocument, ctx: ValidationContext): RecipeFinding[] {
  const model = String(role.config.model ?? "").trim();
  const path = `roles.${role.role}.config.model`;
  const parsed = model ? parseModelId(model) : null;
  if (!parsed) {
    return model ? [finding("model.unknown", "warning", path, `unknown model ${model}; apply asks for one`)] : [];
  }
  const findings: RecipeFinding[] = [];
  if (parsed.provider.kind === "coding" && role.config.coding !== true) {
    findings.push(finding("model.coding", "warning", path, `${model} is only for a coding agent; apply asks for another`));
  }
  if (ctx.connectedProviders && !ctx.connectedProviders.has(parsed.provider.id)) {
    findings.push(
      finding("model.not_connected", "warning", path, `${model} needs a ${providerLabel(parsed.provider.id)} key on Model keys; apply asks for another`),
    );
  }
  return findings;
}

/** A browser flag in config that disagrees with browser.required. */
function browserFlag(role: RecipeRole): RecipeFinding[] {
  if (Boolean(role.config.browser) === role.browser.required) return [];
  return [finding("browser.flag", "error", `roles.${role.role}.browser`, "browser.required must match config.browser")];
}

/** A role with no task: nothing to derive one from, or one apply derives from the focus and objective. */
function taskFindings(role: RecipeRole, recipe: RecipeDocument): RecipeFinding[] {
  if (role.task.body.trim()) return [];
  const path = `roles.${role.role}.task`;
  if (!role.focus.trim() && !recipe.guild.objective.trim() && !recipe.guild.about.trim()) {
    return [finding("task.empty", "error", path, "role needs a task prompt")];
  }
  return [finding("task.derived", "warning", path, "task is empty; apply will use the role focus and guild objective")];
}

/** A role with no routine of its own or in the design. */
function missingSchedule(role: RecipeRole, recipe: RecipeDocument): RecipeFinding[] {
  if (role.schedules.length || recipe.design.routines.some((item) => item.role === role.role)) return [];
  return [
    finding(
      "schedule.missing",
      "warning",
      `roles.${role.role}.schedules`,
      "This role has no routine. Tell the coach how often it should run, for example every 15 minutes.",
    ),
  ];
}

/** Native tools the box does not have. */
function unknownNativeTools(role: RecipeRole): RecipeFinding[] {
  return Object.keys(role.native_tools)
    .filter((name) => !NATIVE.has(name))
    .map((name) => finding("native.unknown", "error", `roles.${role.role}.native_tools.${name}`, `unknown native tool`));
}

/** Routines whose timing does not validate. */
function invalidSchedules(role: RecipeRole): RecipeFinding[] {
  return role.schedules.flatMap((schedule) => {
    try {
      validateTiming(schedule);
      return [];
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid schedule";
      return [finding("schedule.invalid", "error", `roles.${role.role}.schedules.${schedule.key}`, message)];
    }
  });
}

type RecipeScript = RecipeRole["scripts"][number];

/** A script whose name, description, source, or parameters do not validate. */
function invalidScript(script: RecipeScript, path: string): RecipeFinding[] {
  try {
    validateScriptName(script.name);
    validateScriptDescription(script.description);
    validateScriptSource(script.source);
    validateScriptParameters(script.parameters);
    return [];
  } catch (error) {
    return [finding("script.invalid", "error", path, error instanceof Error ? error.message : "invalid script")];
  }
}

/** A script source that holds a literal credential. */
function literalSecret(script: RecipeScript, path: string): RecipeFinding[] {
  if (!/sk-[a-zA-Z0-9]{10,}|api[_-]?key\s*=\s*['"]/i.test(script.source)) return [];
  return [finding("script.literal_secret", "error", path, "script source must not contain literal credential values")];
}

/** A script the Builder wrote that the operator has not reviewed. */
function unreviewedScript(script: RecipeScript, path: string): RecipeFinding[] {
  if (script.author.by !== "builder" || script.author.reviewed) return [];
  return [finding("review.script", "info", path, "Builder-authored script. Edit it here or ask the coach to revise before you validate.")];
}

const SCRIPT_RULES = [invalidScript, literalSecret, unreviewedScript];

function scriptFindings(role: RecipeRole): RecipeFinding[] {
  return role.scripts.flatMap((script) => {
    const path = `roles.${role.role}.scripts.${script.name}`;
    return SCRIPT_RULES.flatMap((rule) => rule(script, path));
  });
}

const ROLE_RULES: RoleRule[] = [
  unknownConfigKeys,
  codingFlag,
  modelFindings,
  harnessFindings,
  browserFlag,
  taskFindings,
  missingSchedule,
  unknownNativeTools,
  invalidSchedules,
  scriptFindings,
];

function roleFindings(recipe: RecipeDocument, ctx: ValidationContext): RecipeFinding[] {
  return recipe.roles.flatMap((role) => ROLE_RULES.flatMap((rule) => rule(role, recipe, ctx)));
}

/** The role handles of the recipe. */
function roleNames(recipe: RecipeDocument): Set<string> {
  return new Set(recipe.roles.map((role) => role.role));
}

/** An error for each role of a table's or a note's `writers` that the recipe does not have. */
function unknownWriterFindings(
  writers: string[],
  roles: Set<string>,
  where: { code: string; path: string },
): RecipeFinding[] {
  return writers
    .filter((writer) => !roles.has(writer))
    .map((writer) => finding(where.code, "error", where.path, `unknown writer role ${writer}`));
}

/** Collection writers the recipe has no role for. */
function collectionWriters(recipe: RecipeDocument): RecipeFinding[] {
  const roles = roleNames(recipe);
  return recipe.collections.flatMap((collection) =>
    unknownWriterFindings(collection.writers, roles, { code: "collection.writer", path: `collections.${collection.name}` }),
  );
}

/** Notes of an unknown role, or with writers the recipe has no role for. */
function noteRoles(recipe: RecipeDocument): RecipeFinding[] {
  const roles = roleNames(recipe);
  return recipe.notes.flatMap((note) => [
    ...(note.role && !roles.has(note.role) ? [finding("note.role", "error", `notes.${note.id}`, "unknown role")] : []),
    ...unknownWriterFindings(note.writers, roles, { code: "note.writer", path: `notes.${note.id}` }),
  ]);
}

/** The notes a role's texts may link to: by id and by destination path. */
type NoteRefs = { ids: Set<string>; paths: Set<string> };

function knownEmbed(href: string, notes: NoteRefs): boolean {
  if (href.startsWith("recipe:") && notes.ids.has(href.slice("recipe:".length))) return true;
  return notes.ids.has(href) || notes.paths.has(href) || isDisplayPath(href);
}

/** Embeds in a role's task that name no recipe note and no display path. */
function unknownEmbeds(role: RecipeRole, notes: NoteRefs): RecipeFinding[] {
  return collectTaskEmbeds(role.task.body)
    .filter((href) => !knownEmbed(href, notes))
    .map((href) =>
      finding(
        "task.embed",
        "error",
        `roles.${role.role}.task`,
        `unknown file link ${href}. Use the note's destination path (guild/…, org/…, agent/<role>/…) or ![[recipe:<note-id>]].`,
      ),
    );
}

/** Note paths in a role's task and routine instructions that name no recipe note. */
function unknownNotePaths(role: RecipeRole, notes: NoteRefs): RecipeFinding[] {
  const texts = [
    { path: `roles.${role.role}.task`, text: role.task.body },
    ...role.schedules.map((schedule) => ({ path: `roles.${role.role}.schedules.${schedule.key}`, text: schedule.instruction })),
  ];
  return texts.flatMap(({ path, text }) =>
    collectRecipeNotePaths(text)
      .filter((notePath) => !notes.paths.has(notePath))
      .map((notePath) =>
        finding(
          "task.note_path",
          "error",
          path,
          `unknown note path ${notePath}. Name a note from notes[] by its destination path (guild/…, org/…, agent/<role>/…).`,
        ),
      ),
  );
}

/** Links in the roles' texts that name no note the recipe seeds. */
function roleLinks(recipe: RecipeDocument): RecipeFinding[] {
  const notes = {
    ids: new Set(recipe.notes.map((note) => note.id)),
    paths: new Set(recipe.notes.map((note) => recipeNotePath(note))),
  };
  return recipe.roles.flatMap((role) => [...unknownEmbeds(role, notes), ...unknownNotePaths(role, notes)]);
}

/** A recipe with no connector. */
function missingConnections(recipe: RecipeDocument): RecipeFinding[] {
  if (recipe.connections.length) return [];
  return [
    finding(
      "connection.missing",
      "warning",
      "connections",
      "No connectors in the recipe. Name a catalog tool in the prompt, or ask the coach to add one.",
    ),
  ];
}

type RecipeConnection = RecipeDocument["connections"][number];

/** A connector the box does not publish: the recipe's own server, one the registry offers, or an unknown one. */
function unpublishedServer(connection: RecipeConnection, ctx: ValidationContext): RecipeFinding[] {
  if (ctx.publishedServers.has(connection.server)) return [];
  const path = `connections.${connection.server}`;
  if (connection.manifest) {
    return [finding("server.organisation", "error", path, "not on this box: add it as this organisation's server from the recipe")];
  }
  const offered = ctx.registryConnectors?.get(connection.server);
  if (offered) {
    return [
      finding(
        "server.registry",
        "error",
        path,
        `not installed: the registry offers ${connection.server}@${offered.version}, which an instance admin installs`,
      ),
    ];
  }
  return [finding("server.unknown", "error", path, "unknown or unpublished connector")];
}

/** Connections whose server the box lacks, or that name roles the recipe does not have. */
function connectionFindings(recipe: RecipeDocument, ctx: ValidationContext): RecipeFinding[] {
  const roles = roleNames(recipe);
  return recipe.connections.flatMap((connection) => [
    ...unpublishedServer(connection, ctx),
    ...Object.keys(connection.roles)
      .filter((role) => !roles.has(role))
      .map((role) => finding("connection.role", "error", `connections.${connection.server}.roles.${role}`, "unknown role")),
  ]);
}

/** The tools and connectors the operator removed, for the Builder to account for. */
function accessCuts(recipe: RecipeDocument): RecipeFinding[] {
  return operatorAccessCuts(recipe).map((cut) =>
    cut.kind === "tool"
      ? finding(
          "access.tool_removed",
          "info",
          `connections.${cut.server}.roles.${cut.role}.tools.${cut.tool}`,
          `Operator removed ${cut.tool} from ${cut.server} for ${cut.role}. Update the standing prompt if it relies on that tool, or ask why it was removed.`,
        )
      : finding(
          "access.connector_removed",
          "info",
          `design.systems.${cut.server}`,
          `Operator removed the ${cut.server} connector. Update prompts that name it, or ask whether to restore it or switch to another system.`,
        ),
  );
}

const MECHANICAL_RULES: RecipeRule[] = [
  agentCapacity,
  browserCapacity,
  codingCapacity,
  unusedRepositories,
  roleFindings,
  collectionWriters,
  noteRoles,
  roleLinks,
  missingConnections,
  connectionFindings,
  accessCuts,
];

export function validateMechanical(recipe: RecipeDocument, ctx: ValidationContext): RecipeFinding[] {
  return MECHANICAL_RULES.flatMap((rule) => rule(recipe, ctx));
}

export function validateRecipe(recipe: RecipeDocument, ctx: ValidationContext): RecipeFinding[] {
  return [...validateMechanical(recipe, ctx), ...validateDesign(recipe, ctx)];
}

export function blockingErrors(findings: RecipeFinding[]): RecipeFinding[] {
  return findings.filter((item) => item.severity === "error");
}

const APPLY_NON_BLOCKING = new Set(["design.poll_dedupe", "design.routine_missing"]);

export function applyBlockingErrors(findings: RecipeFinding[]): RecipeFinding[] {
  return blockingErrors(findings).filter((item) => !APPLY_NON_BLOCKING.has(item.code));
}
