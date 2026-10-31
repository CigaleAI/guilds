import type { CallProgress } from "../../../api/toolProgress";
import type { Harness } from "../../../api/types/agents";
import { isJsonObject } from "../../../api/wire";
import { harnessLabel, isHarness } from "../harness";
import type { FlowCall } from "../runs/runFlowModel";
import {
  codeTaskChanges,
  codeTaskStatus,
  formatDuration,
  formatReturnedData,
  formatToolArgs,
  stripRemainingToolCalls,
  type ReturnedDataInfo,
  type RunMessage,
  type ToolArgsInfo,
  type ToolResultMetadata,
} from "../runs/toolFormat";

/** The views of an opened tool call. */
export type DetailView = "arguments" | "result" | "metadata" | "diff" | "log";

/** A label and its value in a call's Metadata view. */
export type CallFact = [label: string, value: string];

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A value as text; empty when it is missing. */
function valueText(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function shortSha(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 7) : "";
}

/** A call's result metadata; empty before its result is committed. */
export function callMetadata(call: FlowCall): ToolResultMetadata {
  const metadata = call.result?.metadata;
  return isJsonObject(metadata) ? metadata : {};
}

/** The arguments the agent called the tool with. */
export function callArguments(call: FlowCall): ToolArgsInfo {
  return formatToolArgs(call.call?.function?.arguments);
}

/** A code task result's closing `log: <path>` line; the Metadata view names the log instead. */
const TASK_LOG_LINE_RE = /\n*log: [^\n]*\s*$/;

/**
 * What a committed result returned, without the tool-call budget line the runtime appends, nor a
 * code task's log line.
 */
export function returnedData(result: RunMessage): ReturnedDataInfo {
  const content = result.payload?.content;
  if (typeof content !== "string") return formatReturnedData(content);
  const returned = stripRemainingToolCalls(content);
  const task = result.metadata?.tool_name === "code_task";
  return formatReturnedData(task ? returned.replace(TASK_LOG_LINE_RE, "") : returned);
}

/**
 * The harness a code task runs on: the one its result names, else the run's (the agent's harness
 * while the call runs); null for any other tool, or when neither names a known harness.
 */
export function callHarness(
  call: FlowCall,
  runHarness: Harness | null | undefined,
): Harness | null {
  if (call.info.name !== "code_task") return null;
  const named = callMetadata(call).harness;
  if (isHarness(named)) return named;
  return runHarness ?? null;
}

/** The view a call opens on: its result once it failed or has reported progress, else its arguments. */
export function openingView(call: FlowCall, progress: CallProgress | undefined): DetailView {
  return call.error || progress?.lines.length ? "result" : "arguments";
}

/** Whether a call is a code task of a known run that reached an end checkpoint, so has a diff. */
export function hasTaskDiff(call: FlowCall, runId: string | undefined): boolean {
  const endSha = callMetadata(call).end_sha;
  return call.info.name === "code_task" && Boolean(runId) && Boolean(text(endSha));
}

/** Whether a call is a code task of a known run whose result names the log it kept. */
export function hasTaskLog(call: FlowCall, runId: string | undefined): boolean {
  return (
    call.info.name === "code_task" && Boolean(runId) && Boolean(text(callMetadata(call).log_path))
  );
}

/** A code task's checkpoints, start → end, as short shas; empty without both. */
function checkpointRange(meta: ToolResultMetadata): string {
  return meta.start_sha && meta.end_sha
    ? `${shortSha(meta.start_sha)} → ${shortSha(meta.end_sha)}`
    : "";
}

/** A code task's own facts; its session falls back to the one its progress reported. */
function codeTaskFacts(meta: ToolResultMetadata, sessionId: string | null): CallFact[] {
  return [
    ["Status", codeTaskStatus(meta.status)],
    ["Harness", harnessLabel(meta.harness)],
    ["Repository", text(meta.repository)],
    ["Session", text(meta.session_id) || text(sessionId)],
    ["Changes", codeTaskChanges(meta)],
    ["Checkpoints", checkpointRange(meta)],
  ];
}

function lineRange(range: unknown): string {
  return Array.isArray(range) ? `${String(range[0])}–${String(range[1])}` : "";
}

/** How much the output pipeline stored of a result, "original → stored stored"; empty if untouched. */
function storedBytes(meta: ToolResultMetadata): string {
  return meta.original_bytes === undefined
    ? ""
    : `${String(meta.original_bytes)} → ${valueText(meta.stored_bytes)} stored`;
}

/**
 * What the Metadata view lists about a call, a code task's own facts included; facts without a
 * value are left out. `sessionId` is the session the call's progress reported.
 */
export function toolCallFacts(call: FlowCall, sessionId: string | null): CallFact[] {
  const meta = callMetadata(call);
  const task = call.info.name === "code_task";
  const facts: CallFact[] = [
    ["Call", call.id || "—"],
    ["Tool", call.info.name],
    ...(task ? codeTaskFacts(meta, sessionId) : []),
    ["Duration", formatDuration(Number(meta.duration_ms))],
    ["Output filter", valueText(meta.output_filter)],
    ["Exit code", valueText(meta.exit_code)],
    [task ? "Harness log" : "Full output", text(meta.log_path)],
    ["Working directory", text(meta.cwd)],
    ["File", text(meta.path)],
    ["Lines", lineRange(meta.range)],
    ["Same as step", valueText(meta.repeat_of)],
    ["Bytes", storedBytes(meta)],
    ["Tool calls left", valueText(meta.remaining_tool_calls)],
    ["Committed", valueText(call.result?.created_at)],
  ];
  return facts.filter(([, value]) => value);
}
