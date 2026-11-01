import type { ToolKind } from "@guildsrun/ui";
import type {
  MessagePayload,
  Run,
  RunError,
  StepMessage,
  TokenUsage,
  ToolCall,
} from "../../../api/types/runs";
import { toolResultError } from "./toolFormat";
import { classifyToolCall, kindBreakdown } from "./toolKinds";
import type { RunWithTools, ToolCallInfo } from "./toolKinds";

/** A run as the flow reads it: its id, recorded errors, and the tools its config snapshot offered. */
export type FlowRun = RunWithTools & Pick<Run, "id" | "errors">;

/** One requested tool call with its recorded result, its position in the batch from 1, and its classification. */
export type FlowCall<M extends StepMessage = StepMessage> = {
  id: string;
  call: ToolCall;
  result: M | null;
  position: number;
  info: ToolCallInfo;
  error: string | null;
};

/** One model step: the assistant message that requested a batch of calls, numbered within its generation; a result with no matching request has neither. */
export type FlowStep<M extends StepMessage = StepMessage> = {
  index: number | null;
  turn: M | null;
  calls: FlowCall<M>[];
};

/** A stretch of consecutive tool-calling steps in one generation, with the run errors that ended it. */
export type FlowSegment<M extends StepMessage = StepMessage> = {
  type: "flow";
  generation: number | null;
  key: string;
  steps: FlowStep<M>[];
  errors: RunError[];
};

/** A message shown as a plain chat row. */
export type MessageSegment<M extends StepMessage = StepMessage> = { type: "message"; msg: M };

/** One entry of the run's chat: a plain message or a tool flow. */
export type Segment<M extends StepMessage = StepMessage> = FlowSegment<M> | MessageSegment<M>;

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

/** A run's messages split into chat rows and tool flows, with the run errors no flow holds. */
export type FlowSegments<M extends StepMessage = StepMessage> = {
  segments: Segment<M>[];
  unattachedErrors: RunError[];
};

/** One bar of a flow's timeline: a step's model latency or one tool's run time. */
export type TimelineSegment = { kind: ToolKind | "model"; ms: number; label: string };

/** A flow's timeline: its bars in order, and the time they add up to. */
export type FlowTimeline = { segments: TimelineSegment[]; total: number };

function generationOf(msg: StepMessage): number | null {
  const value = msg.metadata.generation ?? 0;
  return value > 0 ? value : null;
}

function makeCall<M extends StepMessage>(
  call: ToolCall,
  result: M | null,
  run: FlowRun | null,
  position: number,
): FlowCall<M> {
  return {
    id: call.id,
    call,
    result,
    position,
    info: classifyToolCall(call, result, run),
    error: toolResultError(result),
  };
}

/** The id of the call a tool result answers; empty when it names none. */
function answeredCallId(payload: MessagePayload): string {
  return payload.role === "tool" ? payload.tool_call_id : "";
}

/** The tool results among a run's messages, by the id of the call each answers. */
function resultsByCallId<M extends StepMessage>(rows: readonly M[]): Map<string, M> {
  const results = new Map<string, M>();
  for (const msg of rows) {
    const callId = answeredCallId(msg.payload);
    if (callId) results.set(callId, msg);
  }
  return results;
}

/** The step of a tool result whose request the run does not hold: one call, named by the result's tool. */
function orphanResultStep<M extends StepMessage>(
  msg: M,
  callId: string,
  run: FlowRun | null,
): FlowStep<M> {
  const orphanCall: ToolCall = {
    id: callId,
    type: "function",
    function: { name: msg.metadata.tool_name || "tool", arguments: "" },
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
function requestedCalls(payload: MessagePayload): readonly ToolCall[] {
  return payload.role === "assistant" ? (payload.tool_calls ?? []) : [];
}

/** Splits a run's ordered messages into chat rows and tool flows, pairing each call with its result and attaching run errors to their flow. */
export function buildFlowSegments<M extends StepMessage>(
  messages: readonly M[] | null | undefined,
  run: FlowRun | null = null,
): FlowSegments<M> {
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
      key: `${run?.id ?? "run"}:${generation ?? "none"}:${msg.seq}`,
      steps: [],
      errors: [],
    };
    segments.push(current);
    return current;
  };

  for (const msg of rows) {
    const { payload } = msg;
    if (payload.role === "tool") {
      const callId = answeredCallId(payload);
      if (!claimResult(handled, callId)) continue;
      flowFor(generationOf(msg), msg).steps.push(orphanResultStep(msg, callId, run));
      continue;
    }
    if (payload.role === "assistant") {
      const generation = generationOf(msg);
      const stepIndex = (stepsByGeneration.get(generation) || 0) + 1;
      stepsByGeneration.set(generation, stepIndex);
      const calls = requestedCalls(payload);
      if (calls.length) {
        const items = calls.map((call, position) => {
          if (call.id) handled.add(call.id);
          return makeCall(call, results.get(call.id) ?? null, run, position + 1);
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

function attachRunErrors<M extends StepMessage>(
  segments: readonly Segment<M>[],
  errors: readonly RunError[] | undefined,
): RunError[] {
  const unattached: RunError[] = [];
  for (const entry of errors ?? []) {
    const { generation } = entry;
    const target =
      generation > 0
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
export function turnText(msg: StepMessage | null | undefined): string {
  return msg?.payload.content ?? "";
}

/** The reasoning recorded for an assistant message; empty when there is none. */
export function turnReasoning(msg: StepMessage | null | undefined): string {
  const value = msg?.metadata.reasoning ?? "";
  return value.trim() ? value : "";
}

/** The token usage recorded for an assistant message; empty when there is none. */
export function turnUsage(msg: StepMessage | null | undefined): Partial<TokenUsage> {
  return msg?.metadata.usage ?? {};
}

/** How long the model took to write an assistant message, in ms; 0 when it is not recorded. */
function turnLatencyMs(msg: StepMessage): number {
  return msg.metadata.latency_ms ?? 0;
}

/** How long a call's tool ran, in ms; 0 before its result, or when it is not recorded. */
function resultDurationMs(result: StepMessage | null): number {
  return result?.metadata.duration_ms ?? 0;
}

/**
 * What a step cost: its model reply's and its calls' results' stored costs, so a tool that records
 * spend, such as `browse`, counts with the model; null when none of them records a cost.
 */
export function stepCostUsd(step: FlowStep): number | null {
  const costs = [step.turn, ...step.calls.map((item) => item.result)]
    .map((msg) => msg?.cost_usd)
    .filter((cost): cost is number => typeof cost === "number");
  return costs.length ? costs.reduce((total, cost) => total + cost, 0) : null;
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
    const cost = stepCostUsd(step);
    if (cost !== null) {
      costUsd += cost;
      hasCost = true;
    }
    if (step.turn) {
      const usage = turnUsage(step.turn);
      modelMs += turnLatencyMs(step.turn);
      inputTokens += usage.input_tokens ?? 0;
      outputTokens += usage.output_tokens ?? 0;
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
export function flowTimeline(flow: FlowSegment): FlowTimeline {
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
