import type { ToolMessage, ToolResultMetadata } from "../db/schema/index.js";
import { capBytes } from "../lib/bytes.js";
import { writeLog } from "../observability/log.js";
import { redact } from "../secrets/index.js";

export const REMAINING_TOOL_CALLS_PREFIX = "remaining_tool_calls: ";
export const LOW_TOOL_CALL_BUDGET = 8;
export const LOW_TOOL_CALL_WRAP_UP =
  "Write durable findings and finish with text. A batch costs one call each.";

export function identityOutput(result: string): string {
  return result;
}

/** How a tool's output was kept: whether it was cut, its size before and after, and why the filter failed. */
export type OutputRecord = Pick<ToolResultMetadata, "truncated" | "original_bytes" | "stored_bytes" | "error">;

/** What an output filter made of a tool's output: its text, or what it threw or returned in place of one. */
type FilteredOutput = { text: string } | { failure: unknown };

function filterOutput(raw: string, outputFilter: (result: string) => string): FilteredOutput {
  let filtered: unknown;
  try {
    filtered = outputFilter(raw);
  } catch (caught) {
    return { failure: caught };
  }
  return typeof filtered === "string" ? { text: filtered } : { failure: new TypeError("output_filter must return str") };
}

export function processOutput(
  raw: string,
  outputFilter: (result: string) => string,
  secrets: Record<string, string>,
  maxBytes: number,
): [string, OutputRecord] {
  let error: string | null = null;
  let filtered: string;
  const output = filterOutput(raw, outputFilter);
  if ("text" in output) {
    filtered = output.text;
  } else {
    const caught = output.failure;
    writeLog("error", caught instanceof Error ? caught.message : String(caught), {
      operation: "tool.output_filter",
      error_type: caught instanceof Error ? caught.name : "Error",
    }, caught);
    filtered = "ERROR: tool output filter failed";
    error = "tool output filter failed";
  }
  const redacted = redact(filtered, secrets);
  const originalBytes = Buffer.from(redacted, "utf8").length;
  const [stored, truncated] = capBytes(redacted, maxBytes);
  return [
    stored,
    {
      truncated,
      original_bytes: originalBytes,
      stored_bytes: Buffer.from(stored, "utf8").length,
      error,
    },
  ];
}

export function remainingAfter(maxToolCalls: number, executed: number): number {
  return Math.max(0, maxToolCalls - executed);
}

export function withRemainingToolCalls(content: string, remaining: number): string {
  const trailer = `${REMAINING_TOOL_CALLS_PREFIX}${remaining}`;
  if (remaining <= LOW_TOOL_CALL_BUDGET) {
    return `${content.trimEnd()}\n\n${LOW_TOOL_CALL_WRAP_UP}\n\n${trailer}`;
  }
  return `${content.trimEnd()}\n\n${trailer}`;
}

export function stampToolResult<M extends ToolResultMetadata>(
  payload: ToolMessage,
  metadata: M,
  remaining: number,
): [ToolMessage, M & { remaining_tool_calls: number }] {
  return [
    { ...payload, content: withRemainingToolCalls(payload.content, remaining) },
    { ...metadata, remaining_tool_calls: remaining },
  ];
}
