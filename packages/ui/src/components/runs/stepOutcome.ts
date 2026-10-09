import type { Segment } from "../../primitives/Mark";

/**
 * How one model step ended, judged by the tool calls it requested together:
 * `ok` finished without changing anything, `wrote` finished and at least one call mutated state
 * (write, memory, execute, act or post), `failed` has a failed call, `running` still waits on a call.
 */
export type StepOutcome = "ok" | "wrote" | "failed" | "running";

/** One step on a generation's strip; weight is usually the step's duration. */
export type StepSegment = {
  weight: number;
  outcome: StepOutcome;
  /** Native tooltip, such as "Step 3 · 4.2s". */
  label?: string;
};

/** Segment fills on paper. */
export const stepToneOnPaper: Record<StepOutcome, Segment["tone"]> = {
  ok: "signal",
  wrote: "tide",
  failed: "plum",
  running: "mauve",
};

/** Segment fills on the plum hero, where plum and tide would disappear. */
export const stepToneOnPlum: Record<StepOutcome, Segment["tone"]> = {
  ok: "signal",
  wrote: "signal-2",
  failed: "plum-soft",
  running: "mauve",
};

export function stepSegments(
  steps: StepSegment[],
  tones: Record<StepOutcome, Segment["tone"]>,
): Segment[] {
  return steps.map((step) => ({
    weight: step.weight,
    tone: tones[step.outcome],
    ...(step.label !== undefined ? { label: step.label } : {}),
  }));
}
