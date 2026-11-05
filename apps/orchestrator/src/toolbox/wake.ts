import { Type } from "typebox";
import { iso } from "../db/views.js";
import type { Wakes } from "../wakes/service.js";
import {
  validateWakeDelay,
  validateWakeNote,
  WAKE_DELAY_MAX_MINUTES,
  WAKE_MESSAGE_MAX,
} from "../wakes/validation.js";
import { ToolUnavailableError } from "./errors.js";
import { jsonArgument } from "./schema.js";
import type { ToolServices } from "./services.js";
import { nativeTool } from "./types.js";

const WAKE_AFTER_DESCRIPTION =
  "Come back to the result of a long process that finishes on its own, such as a CI run, a " +
  "deploy, or an export: this run takes one more turn after `minutes`, opening with a Wake-up " +
  "message, and you decide then what to do. It is for waiting on an outcome you cannot get by " +
  "working, not a way to pause or to pace ordinary work. The run has one pending wake-up; " +
  "setting another replaces it. Write in message what to check and where, because earlier " +
  "tool results are stubbed by the time you wake. Processes on your machine end 5 minutes " +
  "after your last turn, so check a background command with a delay under 5 minutes. For work " +
  "that repeats on a clock, a routine is the right tool. Refused when the run has no wake-ups " +
  "left.";

function wakes(services: ToolServices): Wakes {
  if (services.wakes === null) {
    throw new ToolUnavailableError("wake-ups are not available");
  }
  return services.wakes;
}

export const wakeAfter = nativeTool({
  name: "wake_after",
  description: WAKE_AFTER_DESCRIPTION,
  parameters: Type.Object({
    minutes: jsonArgument({
      type: "integer",
      minimum: 1,
      maximum: WAKE_DELAY_MAX_MINUTES,
      description: `whole minutes from now, 1 to ${WAKE_DELAY_MAX_MINUTES}`,
    }),
    message: Type.Optional(
      jsonArgument({
        type: "string",
        maxLength: WAKE_MESSAGE_MAX,
        description: `optional note to yourself: what to check and where, at most ${WAKE_MESSAGE_MAX} characters`,
      }),
    ),
  }),
  async handler(services, run, _hooks, call) {
    const request = {
      minutes: validateWakeDelay(call.arguments.minutes),
      message: validateWakeNote(call.arguments.message),
      toolCallId: call.id,
    };
    const waking = {
      runId: run.run_id,
      rootRunId: run.chain_root_run_id,
      agentId: run.agent_id,
      maxWakeUps: run.max_wake_ups,
    };
    const set = await wakes(services).set(waking, request, new Date());
    const replaced = set.replaced === null ? "replaced: none" : `replaced: ${set.replaced.id}`;
    return `set ${set.wake.id}, due ${iso(set.wake.due_at)}\n${replaced}\nwake_ups_left: ${set.wakeUpsLeft}`;
  },
});

export const wakeCancel = nativeTool({
  name: "wake_cancel",
  description:
    "Cancel this run's pending wake-up, set with wake_after. Says so when there is none.",
  parameters: Type.Object({}),
  async handler(services, run) {
    const cancelled = await wakes(services).cancel(run.run_id);
    return cancelled === null ? "no pending wake-up" : `cancelled ${cancelled.id}`;
  },
});
