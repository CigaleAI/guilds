import { iso } from "../db/views.js";
import type { RunWakeRow } from "../db/wakes.js";

/** A run's pending wake-up as the run view and the run's stream show it: when it is due, its note, and when it was set. */
export type PendingWakeView = Pick<RunWakeRow, "id" | "due_at" | "message" | "created_at">;

export function pendingWakeItem(row: RunWakeRow): PendingWakeView {
  return {
    id: row.id,
    due_at: iso(row.due_at),
    message: row.message,
    created_at: iso(row.created_at),
  };
}
