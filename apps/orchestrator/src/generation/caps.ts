import type { RunRow } from "../db/runs.js";

const TERMINAL_CAP_OPERATIONS = new Set([
  "generation.max_tool_calls",
  "generation.max_input_tokens",
  "generation.max_chain",
]);

/**
 * The cap the run ended on for good: its tool-call, input-token, or chain cap, which a resume
 * cannot lift. Null when it ended on none of them.
 */
export function terminalCapOf(run: Pick<RunRow, "errors">): string | null {
  return (
    run.errors.find((entry) => TERMINAL_CAP_OPERATIONS.has(entry.operation))?.operation ?? null
  );
}
