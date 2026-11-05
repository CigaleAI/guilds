import type { PendingWake, WakeUp } from "../../../api/types/runs";
import { messageTime, upcomingTime } from "../../../app/format";

/** The transcript row of a fired wake-up: when the agent set it and for when; generic when its message cannot be read. */
export function firedWakeTitle(wake: WakeUp | null, now: Date = new Date()): string {
  if (wake === null) return "Woken by its wake-up";
  return `Woken by its wake-up · set ${messageTime(wake.set_at, now)} for ${messageTime(wake.due_at, now)}`;
}

/** When a pending wake-up is due, as the Chat tab shows it under the transcript. */
export function pendingWakeTitle(wake: PendingWake, now: Date = new Date()): string {
  return `Wakes up at ${upcomingTime(wake.due_at, now)}`;
}

/** What the agent wrote itself to check when it wakes; a line saying so when it wrote nothing. */
export function pendingWakeNote(wake: PendingWake): string {
  return wake.message ?? "The agent left no note.";
}
