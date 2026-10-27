import { callSegment } from "../toolbox/code.js";
import type { Harness } from "../coding/harnesses.js";
import { isPlainRecord, recordOf } from "../db/json.js";
import { parseArguments } from "../toolbox/index.js";

/** The tool calls of a run's history: which are pending, how many ran, and the record of an interrupted one. */

export const INTERRUPTED_CONTENT = "ERROR: execution interrupted";

/** A `code_task` call the orchestrator lost track of when it restarted. */
export type LostCodeTask = {
  harness: Harness;
  repository: string | null;
  session_id: string | null;
  log_path: string | null;
  run_id: string;
  call_id: string;
};

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function callArguments(call: Record<string, unknown>): Record<string, unknown> {
  try {
    return parseArguments(call);
  } catch {
    return {};
  }
}

/** A lost `code_task` call, from what its run remembered about it and from the call's own arguments. */
export function lostCodeTask(run: Record<string, unknown>, call: Record<string, unknown>, harness: Harness): LostCodeTask {
  const callId = callSegment(String(call.id ?? ""));
  const remembered = recordOf(recordOf(run.metadata).harness_task);
  const known = remembered.call_id === callId ? remembered : {};
  const args = callArguments(call);
  return {
    harness,
    repository: optionalText(known.repository) ?? optionalText(args.repo),
    session_id: optionalText(known.session_id) ?? optionalText(args.session_id),
    log_path: optionalText(known.log_path),
    run_id: String(run.id),
    call_id: callId,
  };
}

export function toolCallsOf(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const calls = payload.tool_calls;
  return Array.isArray(calls) ? calls.filter(isPlainRecord) : [];
}

export function executedToolCalls(rows: Array<Record<string, unknown>>): number {
  let total = 0;
  for (const row of rows) {
    if (recordOf(row.payload).role === "tool") {
      total += 1;
    }
  }
  return total;
}

function assistantCallId(call: Record<string, unknown>): string | null {
  return typeof call.id === "string" && call.id ? call.id : null;
}

function rememberPendingAssistantCalls(
  pending: Map<string, [Record<string, unknown>, number]>,
  order: string[],
  payload: Record<string, unknown>,
  generation: number,
): void {
  for (const call of toolCallsOf(payload)) {
    const callId = assistantCallId(call);
    if (!callId) {
      continue;
    }
    if (!pending.has(callId)) {
      order.push(callId);
    }
    pending.set(callId, [call, generation]);
  }
}

function forgetResolvedToolCall(
  pending: Map<string, [Record<string, unknown>, number]>,
  order: string[],
  payload: Record<string, unknown>,
): void {
  const callId = payload.tool_call_id;
  if (typeof callId !== "string") {
    return;
  }
  pending.delete(callId);
  const index = order.indexOf(callId);
  if (index >= 0) {
    order.splice(index, 1);
  }
}

export function pendingToolCalls(
  rows: Array<Record<string, unknown>>,
): Array<[Record<string, unknown>, number]> {
  const pending = new Map<string, [Record<string, unknown>, number]>();
  const order: string[] = [];
  for (const row of rows) {
    const payload = recordOf(row.payload);
    const generation = Number(recordOf(row.metadata).generation || 1);
    if (payload.role === "assistant") {
      rememberPendingAssistantCalls(pending, order, payload, generation);
    } else if (payload.role === "tool") {
      forgetResolvedToolCall(pending, order, payload);
    }
  }
  return order.flatMap((callId) => {
    const item = pending.get(callId);
    return item ? [item] : [];
  });
}

function toolCallNameAndId(call: Record<string, unknown>): { name: string; callId: string } {
  const fn = recordOf(call.function);
  return {
    name: typeof fn.name === "string" ? fn.name : "",
    callId: typeof call.id === "string" ? call.id : "",
  };
}

export function interruptionRecord(
  call: Record<string, unknown>,
  generation: number,
): [Record<string, unknown>, Record<string, unknown>] {
  const { name, callId } = toolCallNameAndId(call);
  const payload = {
    role: "tool",
    tool_call_id: callId,
    content: INTERRUPTED_CONTENT,
  };
  const metadata: Record<string, unknown> = {
    generation,
    tool_name: name,
    tool_call_id: callId,
    duration_ms: 0,
    output_filter: "identity",
    truncated: false,
    original_bytes: Buffer.from(INTERRUPTED_CONTENT, "utf8").length,
    stored_bytes: Buffer.from(INTERRUPTED_CONTENT, "utf8").length,
    error: "execution interrupted",
  };
  if (name === "script_run" || name === "shell") {
    metadata.exit_code = null;
  }
  return [payload, metadata];
}
