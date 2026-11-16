import type { CodingProblem } from "../harness";
import type { ConfigErrors, ConfigForm } from "./configForm";

/** A section of an agent's Settings, opened by `?section=`. */
export type SettingsSection = "identity" | "model" | "machine" | "harness" | "repositories";

/**
 * What an agent's Settings are laid out for: an agent on a key, a coding agent, which leads on a
 * key and delegates to a harness, or a subscription agent, which runs on its harness.
 */
export type SettingsKind = "key" | "coding" | "subscription";

/** The kind of agent the form edits. */
export function settingsKindOf(form: Pick<ConfigForm, "coding" | "model_source">): SettingsKind {
  if (form.coding) return "coding";
  return form.model_source === "subscription" ? "subscription" : "key";
}

/**
 * The sections in order, as the create dialog's steps run: an agent's identity, model, and
 * machine; a coding agent's identity, machine, harness, lead model, and repositories; a
 * subscription agent's identity, harness, machine, and repositories.
 */
export function settingsSections(kind: SettingsKind): SettingsSection[] {
  switch (kind) {
    case "coding":
      return ["identity", "machine", "harness", "model", "repositories"];
    case "subscription":
      return ["identity", "harness", "machine", "repositories"];
    case "key":
      return ["identity", "model", "machine"];
  }
}

export function sectionLabel(section: SettingsSection, kind: SettingsKind): string {
  switch (section) {
    case "identity":
      return "Identity";
    case "model":
      return kind === "coding" ? "Lead model" : "Model";
    case "machine":
      return "Machine";
    case "harness":
      return "Harness";
    case "repositories":
      return "Repositories";
  }
}

/**
 * The section a `?section=` opens: the one named when the agent has it, else where its content
 * lives for this kind of agent (an agent on a key turns Coding on, or picks a subscription, under
 * Model; a subscription agent's model source and capabilities sit under Harness), else Identity.
 */
export function openSection(asked: string | undefined, kind: SettingsKind): SettingsSection {
  const found = settingsSections(kind).find((section) => section === asked);
  if (found) return found;
  if (kind === "key" && (asked === "harness" || asked === "repositories")) return "model";
  if (kind === "subscription" && asked === "model") return "harness";
  return "identity";
}

/** Where a coding-readiness problem is fixed. */
export function problemSection(problem: CodingProblem): SettingsSection {
  return problem.kind === "repositories" ? "repositories" : "harness";
}

/** The config errors each section's fields own. The name's error is Identity's. */
export const sectionErrors: Readonly<Record<SettingsSection, ReadonlyArray<keyof ConfigErrors>>> = {
  identity: [],
  model: [
    "model",
    "temperature",
    "max_tokens",
    "max_steps",
    "max_tool_calls",
    "max_input_tokens",
    "max_wake_ups",
    "max_turn_minutes",
    "keep_tool_result_generations",
    "max_scripts",
    "browser_model",
  ],
  machine: ["machine", "max_workspace_mib"],
  harness: ["harness", "harness_model"],
  repositories: [],
};

/**
 * The config errors a section's fields own for this kind of agent: a subscription agent's Harness
 * also holds the capabilities and run limits that sit under Model on an agent with a model.
 */
export function sectionErrorKeys(
  section: SettingsSection,
  kind: SettingsKind,
): ReadonlyArray<keyof ConfigErrors> {
  if (kind === "subscription" && section === "harness") {
    return [...sectionErrors.harness, ...sectionErrors.model.filter((key) => key !== "model")];
  }
  return sectionErrors[section];
}

/**
 * Whether a new agent's model step is complete: on a key, a provider is connected and the model's
 * fields hold no error; on a subscription, which needs no provider, the harness's fields hold none.
 */
export function modelStepComplete(
  form: Pick<ConfigForm, "coding" | "model_source">,
  errors: ConfigErrors,
  noProvider: boolean,
): boolean {
  if (settingsKindOf(form) === "subscription") {
    return !sectionHasErrors(sectionErrorKeys("harness", "subscription"), errors);
  }
  return !noProvider && !sectionHasErrors(sectionErrors.model, errors);
}

/** Whether any of a section's keys has an error. */
export function sectionHasErrors(
  keys: ReadonlyArray<keyof ConfigErrors>,
  errors: ConfigErrors,
): boolean {
  return keys.some((key) => errors[key] !== undefined);
}
