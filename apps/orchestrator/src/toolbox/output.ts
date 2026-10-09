import { writeLog } from "../observability/log.js";
import { redact } from "../secrets/index.js";

export const TRUNCATION_MARKER = "\n[truncated]";
export const REMAINING_TOOL_CALLS_PREFIX = "remaining_tool_calls: ";
export const LOW_TOOL_CALL_BUDGET = 8;
export const LOW_TOOL_CALL_WRAP_UP =
  "Write durable findings and finish with text. A batch costs one call each.";

export function identityOutput(result: string): string {
  return result;
}

export function capBytes(text: string, maxBytes: number): [string, boolean] {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= maxBytes) {
    return [text, false];
  }
  const marker = Buffer.from(TRUNCATION_MARKER, "utf8");
  const budget = Math.max(0, maxBytes - marker.length);
  const cut = encoded.subarray(0, budget).toString("utf8");
  return [cut + TRUNCATION_MARKER, true];
}

export function processOutput(
  raw: string,
  outputFilter: (result: string) => string,
  secrets: Record<string, string>,
  maxBytes: number,
): [string, Record<string, unknown>] {
  let error: string | null = null;
  let filtered: string;
  try {
    filtered = outputFilter(raw);
    if (typeof filtered !== "string") {
      throw new TypeError("output_filter must return str");
    }
  } catch (caught) {
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
  const body = typeof content === "string" ? content : "";
  const trailer = `${REMAINING_TOOL_CALLS_PREFIX}${remaining}`;
  if (remaining <= LOW_TOOL_CALL_BUDGET) {
    return `${body.trimEnd()}\n\n${LOW_TOOL_CALL_WRAP_UP}\n\n${trailer}`;
  }
  return `${body.trimEnd()}\n\n${trailer}`;
}

export function stampToolResult(
  payload: Record<string, unknown>,
  metadata: Record<string, unknown>,
  remaining: number,
): [Record<string, unknown>, Record<string, unknown>] {
  const content = typeof payload.content === "string" ? payload.content : "";
  return [
    { ...payload, content: withRemainingToolCalls(content, remaining) },
    { ...metadata, remaining_tool_calls: remaining },
  ];
}
