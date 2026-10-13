import type { Harness } from "../../api/types";

/** Each harness's name as the app shows it. */
export const harnessLabels: Readonly<Record<Harness, string>> = Object.freeze({
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
});

/** The harnesses a coding agent can run, as select options. */
export const harnessOptions = (Object.keys(harnessLabels) as Harness[]).map((harness) => ({
  value: harness,
  label: harnessLabels[harness],
}));

export function isHarness(value: unknown): value is Harness {
  return typeof value === "string" && Object.hasOwn(harnessLabels, value);
}

/** A harness's label; the value itself when the app does not know it. */
export function harnessLabel(value: unknown): string {
  return isHarness(value) ? harnessLabels[value] : String(value ?? "");
}

/** Why a harness can be missing from a machine, shown wherever the image decides what can run. */
export const harnessImageNote =
  "A published image carries Codex only; Claude Code and Cursor need an image built with them.";

/**
 * Whether a machine's image carries a harness's CLI: true or false once the machine has started
 * and reported its CLIs, null while that is unknown.
 */
export function harnessCarried(
  carried: readonly Harness[] | null | undefined,
  harness: Harness,
): boolean | null {
  return carried ? carried.includes(harness) : null;
}

/** The harness select's options on a machine: one its image lacks is shown unavailable. */
export function harnessChoices(carried: readonly Harness[] | null | undefined) {
  return harnessOptions.map((option) =>
    harnessCarried(carried, option.value) === false
      ? { ...option, disabled: true, description: "Not on this machine's image" }
      : option,
  );
}

/** Whether the select shows the image note: the machine's CLIs are unknown, or some are missing. */
export function showsHarnessImageNote(carried: readonly Harness[] | null | undefined): boolean {
  return !carried || harnessOptions.some((option) => !carried.includes(option.value));
}
