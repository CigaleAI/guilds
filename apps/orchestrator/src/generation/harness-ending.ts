import { HARNESS_INFO } from "../coding/harnesses.js";
import type { TurnEnding } from "../toolbox/harness-ops.js";
import { failureDetail } from "../toolbox/harness-result.js";
import { HarnessTurnError } from "./errors.js";
import type { SubscriptionGeneration } from "./harness-loop.js";
import { staysOpenAfter } from "./lifecycle.js";

// How a subscription agent's turn on its harness ended, and the run error a turn that did not end
// cleanly fails its generation with.

/** How a subscription agent's turn ended: as a harness's turn does, or stopped at its run's tool calls' asking. */
export type HarnessTurnEnding = Omit<TurnEnding, "settled"> & { settled: TurnEnding["settled"] | "stopped" };

/** A way a started turn can end other than a clean exit, a cancel, or its run's tool calls' stop. */
type UncleanSettled = Exclude<HarnessTurnEnding["settled"], "exited" | "cancelled" | "not_started" | "stopped">;

/** The run error each way a started turn can end other than a clean exit or a cancel. */
const SETTLED_CODE: Record<UncleanSettled, HarnessTurnError["code"]> = {
  missing: "harness.lost",
  unreadable: "harness.lost",
  unresponsive: "harness.unresponsive",
  timed_out: "harness.timed_out",
};

/** What each way a started turn can end other than cleanly says, of `label`'s turn that could run `minutes`. */
const SETTLED_MESSAGE: Record<UncleanSettled, (label: string, minutes: number) => string> = {
  missing: (label) => `${label}'s state is gone: the machine restarted or its container was recreated.`,
  unreadable: (label) => `${label} exited, and its result could not be read.`,
  unresponsive: (label) => `${label} stopped answering, so it was stopped.`,
  timed_out: (label, minutes) => `${label} was stopped after ${minutes} minutes.`,
};

/** The endings that cut a turn short with its session still worth resuming: the CLI did not finish it. */
const CUT_SHORT: ReadonlySet<UncleanSettled> = new Set(["missing", "unresponsive", "timed_out"]);

/**
 * What a turn of `gen` that ended `settled` says of its session: that the run's next turn resumes
 * it, for a turn cut short in a run that stays open for a next generation; empty otherwise.
 */
function sessionNote(gen: SubscriptionGeneration, settled: UncleanSettled): string {
  return CUT_SHORT.has(settled) && staysOpenAfter(gen.run, gen.generation)
    ? " The run's next turn resumes its session."
    : "";
}

/**
 * The run error the turn of `gen` that ended `ending` fails the generation with; null for a turn
 * whose CLI exited cleanly, that was cancelled, or that its run's tool calls stopped, which ends
 * the generation with their own error. A harness that did not stop is named with its log, at
 * `logPath`.
 */
export function harnessTurnFailure(
  gen: SubscriptionGeneration,
  ending: HarnessTurnEnding,
  logPath: string,
): HarnessTurnError | null {
  const harness = gen.snapshot.harness;
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
    SETTLED_MESSAGE[ending.settled](label, gen.snapshot.max_turn_minutes) + sessionNote(gen, ending.settled) + unstopped,
  );
}
