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
