import type { ToolKind } from "@guildsrun/ui";
import { isJsonObject, type JsonObject } from "../../../api/wire";
import { messageContentText, toolResultError } from "./toolFormat";
import type { RunMessage, ToolCallRequest } from "./toolFormat";
import { classifyToolCall, kindBreakdown } from "./toolKinds";
import type { RunWithTools, ToolCallInfo } from "./toolKinds";

/** An error recorded on a run; `generation` ties it to the generation it ended. */
export type RunError = {
  at?: string;
  generation?: number;
  operation?: string;
  message?: string;
  error_type?: string;
};

/** A run as the flow reads it: its id, recorded errors, and the tools its config snapshot offered. */
export type FlowRun = RunWithTools & { id?: string; errors?: readonly RunError[] };

/** One requested tool call with its recorded result, its position in the batch from 1, and its classification. */
export type FlowCall<M extends RunMessage = RunMessage> = {
  id: string;
  call: ToolCallRequest;
  result: M | null;
  position: number;
  info: ToolCallInfo;
  error: string | null;
};

/** One model step: the assistant message that requested a batch of calls, numbered within its generation; a result with no matching request has neither. */
export type FlowStep<M extends RunMessage = RunMessage> = {
  index: number | null;
  turn: M | null;
  calls: FlowCall<M>[];
};

/** A stretch of consecutive tool-calling steps in one generation, with the run errors that ended it. */
export type FlowSegment<M extends RunMessage = RunMessage> = {
  type: "flow";
  generation: number | null;
  key: string;
  steps: FlowStep<M>[];
  errors: RunError[];
};

/** A message shown as a plain chat row. */
export type MessageSegment<M extends RunMessage = RunMessage> = { type: "message"; msg: M };

/** One entry of the run's chat: a plain message or a tool flow. */
export type Segment<M extends RunMessage = RunMessage> = FlowSegment<M> | MessageSegment<M>;

/** Totals for a flow's header: steps, calls, failures, time, tokens, cost, and the kinds of calls made. */
export type FlowStats = {
  steps: number;
  calls: number;
  toolErrors: number;
  errors: number;
  running: number;
  modelMs: number;
  toolMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  kinds: string;
  reasoning: number;
};

/** One bar of a flow's timeline: a step's model latency or one tool's run time. */
export type TimelineSegment = { kind: ToolKind | "model"; ms: number; label: string };

function metaOf(msg: RunMessage | null | undefined): Record<string, unknown> {
  return msg?.metadata ?? {};
}

function payloadOf(msg: RunMessage | null | undefined): Record<string, unknown> {
  return msg?.payload ?? {};
}

function generationOf(msg: RunMessage): number | null {
  const value = Number(metaOf(msg).generation);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function makeCall<M extends RunMessage>(
  call: ToolCallRequest,
  result: M | null,
  run: FlowRun | null,
  position: number,
): FlowCall<M> {
  return {
    id: call?.id ? String(call.id) : "",
    call,
    result,
    position,
    info: classifyToolCall(call, result, run),
    error: toolResultError(result),
  };
}

/** The id of the call a tool result answers; empty when it names none. */
function answeredCallId(payload: Record<string, unknown>): string {
  return payload.tool_call_id ? String(payload.tool_call_id) : "";
}

/** The tool results among a run's messages, by the id of the call each answers. */
function resultsByCallId<M extends RunMessage>(rows: readonly M[]): Map<string, M> {
  const results = new Map<string, M>();
  for (const msg of rows) {
    const payload = payloadOf(msg);
    const callId = answeredCallId(payload);
    if (payload.role === "tool" && callId) results.set(callId, msg);
  }
  return results;
}

/** The step of a tool result whose request the run does not hold: one call, named by the result's tool. */
function orphanResultStep<M extends RunMessage>(
  msg: M,
  callId: string,
  run: FlowRun | null,
): FlowStep<M> {
  const orphanCall: ToolCallRequest = {
    id: callId,
    function: { name: metaOf(msg).tool_name || "tool", arguments: "" },
  };
  return { index: null, turn: null, calls: [makeCall(orphanCall, msg, run, 1)] };
}

/**
 * Records that the result of a call has its step in the flow; false when one already has. A result
 * that names no call always gets a step of its own.
 */
function claimResult(handled: Set<string>, callId: string): boolean {
  if (!callId) return true;
  if (handled.has(callId)) return false;
  handled.add(callId);
  return true;
}

/** The tool calls an assistant message requested; empty when it requested none. */
function requestedCalls(payload: Record<string, unknown>): readonly ToolCallRequest[] {
  return Array.isArray(payload.tool_calls) ? payload.tool_calls : [];
}

/** Splits a run's ordered messages into chat rows and tool flows, pairing each call with its result and attaching run errors to their flow. */
export function buildFlowSegments<M extends RunMessage>(
  messages: readonly M[] | null | undefined,
  run: FlowRun | null = null,
): { segments: Segment<M>[]; unattachedErrors: RunError[] } {
  const rows: readonly M[] = Array.isArray(messages) ? messages : [];
  const results = resultsByCallId(rows);
  const handled = new Set<string>();
  const stepsByGeneration = new Map<number | null, number>();
  const segments: Segment<M>[] = [];
  let current: FlowSegment<M> | null = null;

  const flowFor = (generation: number | null, msg: M): FlowSegment<M> => {
    if (current && current.generation === generation) return current;
    current = {
      type: "flow",
      generation,
      key: `${run?.id ?? "run"}:${generation ?? "none"}:${msg.seq ?? msg.id ?? segments.length}`,
      steps: [],
      errors: [],
    };
    segments.push(current);
    return current;
  };

  for (const msg of rows) {
    const payload = payloadOf(msg);
    const role = payload.role || "assistant";
    if (role === "tool") {
      const callId = answeredCallId(payload);
      if (!claimResult(handled, callId)) continue;
      flowFor(generationOf(msg), msg).steps.push(orphanResultStep(msg, callId, run));
      continue;
    }
    if (role === "assistant") {
      const generation = generationOf(msg);
      const stepIndex = (stepsByGeneration.get(generation) || 0) + 1;
      stepsByGeneration.set(generation, stepIndex);
      const calls = requestedCalls(payload);
      if (calls.length) {
        const items = calls.map((call, position) => {
          const id = call?.id ? String(call.id) : "";
          if (id) handled.add(id);
          return makeCall(call, id ? (results.get(id) ?? null) : null, run, position + 1);
        });
        flowFor(generation, msg).steps.push({ index: stepIndex, turn: msg, calls: items });
        continue;
      }
    }
    current = null;
    segments.push({ type: "message", msg });
  }
  const unattachedErrors = attachRunErrors(segments, run?.errors);
  return { segments, unattachedErrors };
}

function attachRunErrors<M extends RunMessage>(
  segments: readonly Segment<M>[],
  errors: readonly RunError[] | undefined,
): RunError[] {
  const unattached: RunError[] = [];
  for (const entry of Array.isArray(errors) ? errors : []) {
    const generation = Number(entry?.generation);
    const target =
      Number.isFinite(generation) && generation > 0
        ? segments.findLast(
            (segment): segment is FlowSegment<M> =>
              segment.type === "flow" && segment.generation === generation,
          )
        : undefined;
    if (target) target.errors.push(entry);
    else unattached.push(entry);
  }
  return unattached;
}

/** The text an assistant message said alongside its tool calls. */
export function turnText(msg: RunMessage | null | undefined): string {
  return messageContentText(payloadOf(msg));
}

/** The reasoning recorded for an assistant message; empty when there is none. */
export function turnReasoning(msg: RunMessage | null | undefined): string {
  const value = metaOf(msg).reasoning;
  return typeof value === "string" && value.trim() ? value : "";
}

/** The token usage recorded for an assistant message; empty when there is none. */
export function turnUsage(msg: RunMessage | null | undefined): JsonObject {
  const usage = metaOf(msg).usage;
  return isJsonObject(usage) ? usage : {};
}

/** How long the model took to write an assistant message, in ms; 0 when it is not recorded. */
function turnLatencyMs(msg: RunMessage): number {
  return Number(metaOf(msg).latency_ms) || 0;
}

/** How long a call's tool ran, in ms; 0 before its result, or when it is not recorded. */
function resultDurationMs(result: RunMessage | null): number {
  return Number(metaOf(result).duration_ms) || 0;
}

/** Sums a flow's steps, calls, failures, running calls, model and tool time, tokens, and cost. */
export function flowStats(flow: FlowSegment): FlowStats {
  let calls = 0;
  let toolErrors = 0;
  let running = 0;
  let modelMs = 0;
  let toolMs = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let hasCost = false;
  let reasoning = 0;
  const infos: ToolCallInfo[] = [];
  for (const step of flow.steps) {
    if (step.turn) {
      const meta = metaOf(step.turn);
      const usage = turnUsage(step.turn);
      modelMs += turnLatencyMs(step.turn);
      inputTokens += Number(usage.input_tokens) || 0;
      outputTokens += Number(usage.output_tokens) || 0;
      const cost = meta.cost_usd;
      if (typeof cost === "number") {
        costUsd += cost;
        hasCost = true;
      }
      if (turnReasoning(step.turn)) reasoning += 1;
    }
    for (const item of step.calls) {
      calls += 1;
      infos.push(item.info);
      if (item.error) toolErrors += 1;
      if (!item.result) running += 1;
      toolMs += resultDurationMs(item.result);
    }
  }
  return {
    steps: flow.steps.length,
    calls,
    toolErrors,
    errors: toolErrors + flow.errors.length,
    running,
    modelMs,
    toolMs,
    inputTokens,
    outputTokens,
    costUsd: hasCost ? costUsd : null,
    kinds: kindBreakdown(infos),
    reasoning,
  };
}

/** The flow's timeline bars in order: each step's model latency, then each of its tools' run times. */
export function flowTimeline(flow: FlowSegment): { segments: TimelineSegment[]; total: number } {
  const segments: TimelineSegment[] = [];
  for (const step of flow.steps) {
    const label = step.index === null ? "Tool result" : `Step ${step.index}`;
    if (step.turn) {
      const ms = turnLatencyMs(step.turn);
      if (ms > 0) segments.push({ kind: "model", ms, label: `${label} · model` });
    }
    for (const item of step.calls) {
      const ms = resultDurationMs(item.result);
      if (ms > 0)
        segments.push({ kind: item.info.kind, ms, label: `${label} · ${item.info.name}` });
    }
  }
  const total = segments.reduce((sum, segment) => sum + segment.ms, 0);
  return { segments, total };
}
