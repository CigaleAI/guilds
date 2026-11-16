import { HARNESS_INFO } from "../coding/harnesses.js";
import type { Harness } from "../db/schema/index.js";
import type { TurnEnding } from "../toolbox/harness-ops.js";
import { failureDetail } from "../toolbox/harness-result.js";
import { HarnessTurnError } from "./errors.js";

// How a subscription agent's turn on its harness ended, and the run error a turn that did not end
// cleanly fails its generation with.

/** How a subscription agent's turn ended: as a harness's turn does, or stopped at its run's tool calls' asking. */
export type HarnessTurnEnding = Omit<TurnEnding, "settled"> & { settled: TurnEnding["settled"] | "stopped" };

/** The run error each way a started turn can end other than a clean exit or a cancel. */
const SETTLED_CODE: Record<
  Exclude<HarnessTurnEnding["settled"], "exited" | "cancelled" | "not_started" | "stopped">,
  HarnessTurnError["code"]
> = {
  missing: "harness.lost",
  unreadable: "harness.lost",
  unresponsive: "harness.unresponsive",
  timed_out: "harness.timed_out",
};

/** What each way a started turn can end other than cleanly says, of `label`'s turn that could run `minutes`. */
const SETTLED_MESSAGE: Record<keyof typeof SETTLED_CODE, (label: string, minutes: number) => string> = {
  missing: (label) =>
    `${label}'s state is gone: the machine restarted or its container was recreated. The run's next turn resumes its session.`,
  unreadable: (label) => `${label} exited, and its result could not be read.`,
  unresponsive: (label) =>
    `${label} stopped answering, so it was stopped. The run's next turn resumes its session.`,
  timed_out: (label, minutes) =>
    `${label} was stopped after ${minutes} minutes. The run's next turn resumes its session.`,
};

/**
 * The run error a turn that ended `ending`, and could run `minutes`, fails its generation with;
 * null for a turn whose CLI exited cleanly, that was cancelled, or that its run's tool calls
 * stopped, which ends the generation with their own error. A harness that did not stop is named
 * with its log.
 */
export function harnessTurnFailure(
  harness: Harness,
  ending: HarnessTurnEnding,
  logPath: string,
  minutes: number,
): HarnessTurnError | null {
  const label = HARNESS_INFO[harness].label;
  const unstopped =
    ending.stopped === false
      ? ` It did not stop and may still be running; its log is ${logPath}.`
      : "";
  if (ending.settled === "exited") {
    const result = ending.result ?? {};
    return result.exit_code === 0 && result.is_error !== true
      ? null
      : new HarnessTurnError(
          "harness.failed",
          `${label}'s turn failed (${failureDetail(harness, result, null)})`,
        );
  }
  if (ending.settled === "cancelled" || ending.settled === "not_started" || ending.settled === "stopped") {
    return null;
  }
  return new HarnessTurnError(
    SETTLED_CODE[ending.settled],
    SETTLED_MESSAGE[ending.settled](label, minutes) + unstopped,
  );
}
