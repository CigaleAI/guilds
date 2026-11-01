import { collectRunState, type RunState } from "../../src/state/index.js";

/** A run's State in a guild with no members and no chat, at a fixed instant; `extra` sits beside core's keys. */
export function emptyRunState(extra: Partial<RunState> = {}): RunState {
  const core = collectRunState(null, "acme", "research", "researcher", {
    members: [],
    historyRows: [],
    now: new Date("2026-09-13T09:00:12.000Z"),
  });
  return { ...core, ...extra };
}
