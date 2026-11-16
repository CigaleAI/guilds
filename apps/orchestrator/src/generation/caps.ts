import type { RunRow } from "../db/runs.js";

const TERMINAL_CAP_OPERATIONS = new Set([
  "generation.max_tool_calls",
  "generation.max_input_tokens",
]);

/**
 * The cap the run ended on for good: its tool-call or input-token cap, which a resume
 * cannot lift and a wake-up does not reopen. Null when it ended on none of them.
 */
export function terminalCapOf(run: Pick<RunRow, "errors">): string | null {
  return (
    run.errors.find((entry) => TERMINAL_CAP_OPERATIONS.has(entry.operation))?.operation ?? null
  );
}
