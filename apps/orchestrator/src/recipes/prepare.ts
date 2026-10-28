import type { Effort, Harness } from "../db/schema/index.js";
import { isValidSecretAliases } from "../agents/config.js";
import { harnessModelOf, harnessOf } from "../coding/harnesses.js";
import { harnessEffortOf, harnessEffortsFor } from "../coding/harness-models.js";
import { INSTRUCTION_MAX, validateCron } from "../schedules/cron.js";
import { builderAuthor, type RecipeDocument, type RecipeRole, type RecipeSchedule } from "./schema.js";

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

/** The harness the recipe names, while the role applies with it; else null. */
function keptRecipeHarness(roleConfig: Record<string, unknown>, applied: Harness | null): Harness | null {
  return applied !== null && applied === harnessOf(roleConfig) ? applied : null;
}

/** The recipe's harness model, kept only while the role applies with the harness the recipe names. */
function appliedHarnessModel(roleConfig: Record<string, unknown>, applied: Harness | null): string | null {
  return keptRecipeHarness(roleConfig, applied) === null ? null : harnessModelOf(roleConfig);
}

/** The recipe's harness effort, kept only with the recipe's harness and when its model runs at it. */
function appliedHarnessEffort(roleConfig: Record<string, unknown>, applied: Harness | null): Effort | null {
  const kept = keptRecipeHarness(roleConfig, applied);
  const effort = harnessEffortOf(roleConfig);
  if (kept === null || effort === null) {
    return null;
  }
  return harnessEffortsFor(kept, harnessModelOf(roleConfig)).includes(effort) ? effort : null;
}

/** The model and harness the operator chose for a role; the recipe's where one is absent. */
export type RoleChoice = { model?: string | undefined; harness?: Harness | undefined };

/**
 * The agent config a role applies as: the role's, with the model and harness the operator chose
 * (else the recipe's), and the browser and coding flags settled. Only a coding role keeps a
 * harness, and the recipe's harness model and effort only with the recipe's harness, and secret
 * aliases that do not validate are left out. Every other setting the role leaves out takes its
 * default when `validateAgentConfig` reads the config. The machine the agent goes on is the apply's.
 */
export function configFromRecipeRole(role: RecipeRole, choice: RoleChoice = {}): Record<string, unknown> {
  const roleConfig = { ...role.config };
  const recommended = typeof roleConfig.model === "string" ? roleConfig.model.trim() : "";
  const coding = roleCodes(role);
  const applied = coding ? (choice.harness ?? harnessOf(roleConfig)) : null;
  return {
    ...roleConfig,
    model: choice.model ?? recommended,
    browser: roleBrowses(role),
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
