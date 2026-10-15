import type { CodingProblem } from "../harness";
import type { ConfigErrors } from "./configForm";

/** A section of an agent's Settings, opened by `?section=`. */
export type SettingsSection = "identity" | "model" | "machine" | "harness" | "repositories";

/**
 * The sections in order, as the create dialog's steps run: an agent's identity, model, and
 * machine; a coding agent's identity, machine, harness, lead model, and repositories.
 */
export function settingsSections(coding: boolean): SettingsSection[] {
  return coding
    ? ["identity", "machine", "harness", "model", "repositories"]
    : ["identity", "model", "machine"];
}

export function sectionLabel(section: SettingsSection, coding: boolean): string {
  switch (section) {
    case "identity":
      return "Identity";
    case "model":
      return coding ? "Lead model" : "Model";
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
 * lives for this kind of agent (an agent without coding turns it on under Model), else Identity.
 */
export function openSection(asked: string | undefined, coding: boolean): SettingsSection {
  const sections = settingsSections(coding);
  const found = sections.find((section) => section === asked);
  if (found) return found;
  if (!coding && (asked === "harness" || asked === "repositories")) return "model";
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
    "keep_tool_result_generations",
    "max_scripts",
  ],
  machine: ["machine", "max_workspace_mib"],
  harness: ["harness", "harness_model"],
  repositories: [],
};

/** Whether any of a section's keys has an error. */
export function sectionHasErrors(
  keys: ReadonlyArray<keyof ConfigErrors>,
  errors: ConfigErrors,
): boolean {
  return keys.some((key) => errors[key] !== undefined);
}
