import type { CallProgress } from "../../../api/toolProgress";
import type { StepMessage, StepMetadata } from "../../../api/types/runs";
import { harnessLabel } from "../harness";
import type { FlowCall } from "../runs/runFlowModel";
import {
  formatDuration,
  formatReturnedData,
  formatToolArgs,
  stripRemainingToolCalls,
  type ReturnedDataInfo,
  type ToolArgsInfo,
} from "../runs/toolFormat";

/** The views of an opened tool call. */
export type DetailView = "arguments" | "result" | "metadata";

/** A label and its value in a call's Metadata view. */
export type CallFact = [label: string, value: string];

/** A count or code as text; empty when it is missing. */
function numberText(value: number | null | undefined): string {
  return value === undefined || value === null ? "" : String(value);
}

/** A call's result metadata; empty before its result is committed. */
export function callMetadata(call: FlowCall): StepMetadata {
  return call.result?.metadata ?? {};
}

/** The arguments the agent called the tool with. */
export function callArguments(call: FlowCall): ToolArgsInfo {
  return formatToolArgs(call.call.function.arguments);
}

/** What a committed result returned, without the tool-call budget line the runtime appends. */
export function returnedData(result: StepMessage): ReturnedDataInfo {
  return formatReturnedData(stripRemainingToolCalls(result.payload.content));
}

/** The view a call opens on: its result once it failed or has reported progress, else its arguments. */
export function openingView(call: FlowCall, progress: CallProgress | undefined): DetailView {
  return call.error || progress?.lines.length ? "result" : "arguments";
}

/** How much the output pipeline stored of a result, "original → stored stored"; empty if untouched. */
function storedBytes(meta: StepMetadata): string {
  return meta.original_bytes === undefined
    ? ""
    : `${meta.original_bytes} → ${numberText(meta.stored_bytes)} stored`;
}

/** What the Metadata view lists about a call; facts without a value are left out. */
export function toolCallFacts(call: FlowCall): CallFact[] {
  const meta = callMetadata(call);
  const facts: CallFact[] = [
    ["Call", call.id || "—"],
    ["Tool", call.info.name],
    ["Called by", harnessLabel(meta.from_harness)],
    ["Duration", meta.duration_ms === undefined ? "" : formatDuration(meta.duration_ms)],
    ["Output filter", meta.output_filter ?? ""],
    ["Exit code", numberText(meta.exit_code)],
    ["Bytes", storedBytes(meta)],
    ["Tool calls left", numberText(meta.remaining_tool_calls)],
    ["Committed", call.result?.created_at ?? ""],
  ];
  return facts.filter(([, value]) => value);
}
