import type { UserMessage } from "../db/schema/index.js";
import { iso, isoOrNull } from "../db/views.js";
import type { RunWakeRow } from "../db/wakes.js";

const WAKE_PREFIX = "Wake-up: ";

/** The metadata of the user message a fired wake-up opens its generation with. */
export type WakeMessageMetadata = {
  generation: number;
  source: "wake";
  wake_id: string;
  reopened_run: boolean;
};

/**
 * The user message a fired wake-up opens generation `generation` with: when it was set, due and
 * fired, the agent's note, and how many wake-ups the run has left. `reopenedRun` records that the
 * wake-up reopened a completed run, which completes again when the generation ends.
 */
export function wakeUserMessage(
  wake: RunWakeRow,
  wakeUpsLeft: number,
  generation: number,
  reopenedRun: boolean,
): [UserMessage, WakeMessageMetadata] {
  const info = {
    id: wake.id,
    set_at: iso(wake.created_at),
    due_at: iso(wake.due_at),
    fired_at: isoOrNull(wake.fired_at),
    message: wake.message,
    wake_ups_left: wakeUpsLeft,
  };
  return [
    { role: "user", content: `${WAKE_PREFIX}${JSON.stringify(info, null, 2)}` },
    { generation, source: "wake", wake_id: wake.id, reopened_run: reopenedRun },
  ];
}
