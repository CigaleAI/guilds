import type {
  Effort,
  Harness,
  RecipeDocument,
  RecipeRole,
  RecipeSchedule,
} from "../db/schema/index.js";
import { AGENT_CONFIG_DEFAULTS, MODEL_LOOP_SETTINGS } from "../agents/config.js";
import { isValidSecretAliases } from "../agents/validation.js";
import { harnessModelOf, harnessOf } from "../coding/harnesses.js";
import { harnessEffortOf, harnessEffortsFor } from "../coding/harness-models.js";
import { INSTRUCTION_MAX, validateCron } from "../schedules/cron.js";
import { recommendedModelOf } from "./parse-roles.js";
import { builderAuthor } from "./schema.js";

// A recipe as apply creates it: each role's config settled, its task filled from its focus and
// the guild's objective when it has none, and its routines read from the design when it lists none.

export function clippedInstruction(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= INSTRUCTION_MAX ? trimmed : trimmed.slice(0, INSTRUCTION_MAX);
}

export function withTrailingNewline(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
}

/** The role's task: its own, else its focus with the guild's objective and about. */
export function roleTaskText(role: RecipeRole, recipe: RecipeDocument): string {
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

/** The role's routines: its own, else the design's routines of the role with a cron cadence. */
export function schedulesForRole(role: RecipeRole, recipe: RecipeDocument): RecipeSchedule[] {
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

/** Whether a role's agent runs a browser. */
export function roleBrowses(role: RecipeRole): boolean {
  return Boolean(role.browser.required || role.config.browser);
}

/** Whether a role's agent codes. */
export function roleCodes(role: RecipeRole): boolean {
  return role.config.coding === true;
}

/**
 * Whether a role's agent holds a harness, which it takes at apply: a coding role, or a
 * subscription role. Each counts against the coding agents cap, as `countsAsCodingAgent` reads an agent.
 */
export function roleTakesHarness(role: RecipeRole): boolean {
  return roleCodes(role) || roleRunsOnSubscription(role);
}

/** Whether a role's agent runs on a subscription: it names a harness, no model, and does not code. */
export function roleRunsOnSubscription(role: RecipeRole): boolean {
  return !roleCodes(role) && harnessOf(role.config) !== null && recommendedModelOf(role.config) === null;
}

/** The harness a subscription role's agent runs every turn on; null for any other role. */
export function subscriptionHarnessOf(role: RecipeRole): Harness | null {
  return roleRunsOnSubscription(role) ? harnessOf(role.config) : null;
}

/** The harness the recipe names, while the role applies with it; else null. */
function keptRecipeHarness(roleConfig: RecipeRole["config"], applied: Harness | null): Harness | null {
  return applied !== null && applied === harnessOf(roleConfig) ? applied : null;
}

/** The recipe's harness model, kept only while the role applies with the harness the recipe names. */
function appliedHarnessModel(roleConfig: RecipeRole["config"], applied: Harness | null): string | null {
  return keptRecipeHarness(roleConfig, applied) === null ? null : harnessModelOf(roleConfig);
}

/** The recipe's harness effort, kept only with the recipe's harness and when its model runs at it. */
function appliedHarnessEffort(roleConfig: RecipeRole["config"], applied: Harness | null): Effort | null {
  const kept = keptRecipeHarness(roleConfig, applied);
  const effort = harnessEffortOf(roleConfig);
  if (kept === null || effort === null) {
    return null;
  }
  return harnessEffortsFor(kept, harnessModelOf(roleConfig)).includes(effort) ? effort : null;
}

/** The model and harness the operator chose for a role; the recipe's where one is absent. */
export type RoleChoice = { model?: string | undefined; harness?: Harness | undefined };

/** The model-loop settings a subscription role sets to something other than its default. */
export function subscriptionLoopSettings(role: RecipeRole): string[] {
  if (!roleRunsOnSubscription(role)) {
    return [];
  }
  return MODEL_LOOP_SETTINGS.filter((key) => key in role.config && role.config[key] !== AGENT_CONFIG_DEFAULTS[key]);
}

/** A role's config without the model-loop settings of a subscription role, which apply leaves out. */
function withoutSubscriptionLoopSettings(role: RecipeRole): RecipeRole["config"] {
  const left = new Set(subscriptionLoopSettings(role));
  return Object.fromEntries(Object.entries(role.config).filter(([key]) => !left.has(key)));
}

/**
 * The agent config a role applies as: the role's, with the model and harness the operator chose
 * (else the recipe's), and the browser and coding flags settled. A subscription role has no model
 * and leaves out the model-loop settings it sets. Only a coding role and a subscription role keep
 * a harness, and the recipe's harness model and effort only with the recipe's harness, and secret
 * aliases that do not validate are left out. The agent browses with the step-by-step browser
 * tools. Every other setting the role leaves out takes its
 * default when `validateAgentConfig` reads the config. The machine the agent goes on is the apply's.
 */
export function configFromRecipeRole(role: RecipeRole, choice: RoleChoice = {}): RecipeRole["config"] {
  const roleConfig = withoutSubscriptionLoopSettings(role);
  const coding = roleCodes(role);
  const subscription = roleRunsOnSubscription(role);
  const applied = roleTakesHarness(role) ? (choice.harness ?? harnessOf(roleConfig)) : null;
  return {
    ...roleConfig,
    model: subscription ? null : (choice.model ?? recommendedModelOf(roleConfig) ?? ""),
    browser: roleBrowses(role),
    browser_optimized: false,
    browser_model: null,
    coding,
    harness: applied,
    harness_model: appliedHarnessModel(roleConfig, applied),
    harness_effort: appliedHarnessEffort(roleConfig, applied),
    secret_aliases: isValidSecretAliases(roleConfig.secret_aliases) ? roleConfig.secret_aliases : {},
  };
}

/** The model and harness chosen per role, by role. */
export type RoleChoices = { models?: Map<string, string>; harnesses?: Map<string, Harness> };

/** A copy of `document` as apply creates it: each role's config, task and routines settled. */
export function prepareRecipeForApply(document: RecipeDocument, choices: RoleChoices = {}): RecipeDocument {
  const recipe = structuredClone(document);
  for (const role of recipe.roles) {
    role.config = configFromRecipeRole(role, {
      model: choices.models?.get(role.role),
      harness: choices.harnesses?.get(role.role),
    });
    if (!role.task.body.trim()) {
      role.task.body = roleTaskText(role, recipe);
    }
    if (!role.schedules.length) {
      role.schedules = schedulesForRole(role, recipe);
    }
  }
  return recipe;
}
